/**
 * The runner.
 *
 * Given one thing — its own ENS name — it finds out what it is, checks every
 * tick that it is still allowed to be that, records on chain that it is still
 * alive, and shuts itself down when the answer becomes no.
 *
 * Boot is strict and the loop is forgiving. A misconfigured agent must never
 * start; a running agent must not die because an RPC hiccuped. Exactly one
 * thing is fatal at runtime, and it is the owner revoking the agent's write
 * permission on its own name.
 *
 * Two cadences, because the check and the record are not the same job:
 *
 *   TICK_SECONDS       a free eth_call that asks whether the permission is
 *                      still held. Brisk, so a revocation is caught in seconds.
 *   HEARTBEAT_SECONDS  a real transaction that writes `beat-<n>`. Costs gas, so
 *                      it is not brisk — but it is the only part an observer
 *                      with nothing but the chain can see.
 *
 * The agent therefore needs a funded wallet. It is still the least privileged
 * key in the system: it can write one text record on one name, and an empty
 * one degrades to the old read-only behaviour rather than stopping.
 */
import "dotenv/config";
import type { Address, PublicClient } from "viem";
import { formatEther, formatGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRunnerClient, createRunnerWallet } from "./chain.js";
import { ConfigError, loadCapsuleConfig, type CapsuleConfig } from "./config.js";
import { InvalidEnvError, MissingEnvError, loadEnv } from "./env.js";
import { shortRevert } from "./errors.js";
import { classifyHeartbeatFailure, confirmRevoked, type HeartbeatVerdict } from "./halt.js";
import { BEAT_GAS, LOW_BEATS, heartbeatValue, probeHeartbeat, readFunding, writeHeartbeat } from "./heartbeat.js";
import { HEARTBEAT_KEY } from "./records.js";
import { Gateway, runtimeProblems, telegramIsOpen, type WalletAccess } from "./openclaw.js";
import { describePolicy, spendHeadline, spendable } from "./policy.js";
import type { SpendStatus } from "./persona.js";
import { Serializer } from "./serial.js";
import { WalletBroker } from "./wallet.js";
import { PromptCache, PromptError } from "./prompt.js";
import { RuntimeError, describeCredentials, fetchRuntime, type RuntimeCredentials } from "./runtime.js";
import { describeSecret } from "./secret.js";

/** Consecutive transient failures before giving up. Reset by any success. */
const FAILURE_BUDGET = 5;

/** A slow chain must never turn the cadence into a busy loop. */
const MIN_SLEEP_MS = 5_000;

/**
 * How stale the balance in the agent's own status file is allowed to get.
 *
 * `readFunding` is two calls the tick loop does not otherwise make, and a tick
 * is every 30 seconds by default. Re-reading it on each one would add ~5,700
 * requests a day per capsule to answer a question whose answer only moves when
 * this agent beats or its owner tops it up — and a beat forces a refresh anyway,
 * so the interval only governs how quickly a top-up becomes visible.
 */
const FUNDING_REFRESH_MS = 300_000;

const stamp = () => new Date().toISOString().slice(11, 19);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const eth = (wei: bigint) => `${Number(formatEther(wei)).toFixed(6)} ETH`;
const gwei = (wei: bigint) => `${Number(formatGwei(wei)).toFixed(2)} gwei`;
const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, noun: string) => `${count(n)} ${noun}${n === 1 ? "" : "s"}`;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * How much longer this agent can afford to say it is alive, as one phrase.
 *
 * Reported at boot whether or not it is a problem, and again every time a beat
 * cannot be paid for. A silent heartbeat is the shape of a revocation, so the
 * reason for one has to already be in the log, not looked up afterwards.
 *
 * Never throws. Not knowing the balance is not a reason to stop.
 */
async function funding(
  client: PublicClient,
  agent: Address,
): Promise<{ text: string; low: boolean; ok: boolean; balance: bigint; gasPrice: bigint | undefined }> {
  try {
    const { balance, gasPrice, beats, low } = await readFunding(client, agent);
    return {
      text: `${eth(balance)} · ~${count(beats)} beats at ${gwei(gasPrice)}`,
      low,
      ok: true,
      // Raw as well as formatted. The spendable figure in the agent's status
      // block is derived from these two, and re-reading them for it would double
      // this function's cost to answer a question it has already asked.
      balance,
      gasPrice,
    };
  } catch (error) {
    // `ok` exists because the two callers want different things from a failed
    // read. A log line can print "balance unreadable" and move on; the agent's
    // own status file must not, because "balance unreadable — HTTP 429" sitting
    // in a table headed *Wallet balance* is how a model ends up telling its
    // owner that is what it holds.
    return {
      text: `balance unreadable — ${shortRevert(error)}`,
      low: false,
      ok: false,
      balance: 0n,
      gasPrice: undefined,
    };
  }
}

/**
 * What a failed probe or write meant, having asked the chain rather than
 * guessed. Never returns on a confirmed revocation — it exits 0 there.
 *
 * "revoked" coming back out means the revert said so but the role table
 * disagreed, which is not a revocation and is treated like any other bad
 * minute: logged, counted, survived.
 */
async function reckon(args: {
  error: unknown;
  client: PublicClient;
  config: CapsuleConfig;
  agent: Address;
  ticks: number;
  beats: number;
  gateway: Gateway;
  broker: WalletBroker | undefined;
}): Promise<HeartbeatVerdict> {
  const { error, client, config, agent, ticks, beats, gateway, broker } = args;
  const verdict = classifyHeartbeatFailure(error);

  if (verdict === "unfunded") {
    const { text } = await funding(client, agent);
    console.warn(
      `⚠️  ${stamp()}  beat unaffordable · ${text} — the permission is intact, the wallet is not. Fund ${agent}`,
    );
    return verdict;
  }

  if (verdict !== "revoked") {
    console.warn(`⚠️  ${stamp()}  tick ${ticks} failed — ${shortRevert(error)}`);
    return verdict;
  }

  console.log(`🔴 ${stamp()}  denied — setText(${HEARTBEAT_KEY}) refused by the resolver`);

  // The revert names the name-level resource whichever key was denied, so ask
  // the role table directly before concluding anything.
  const { revoked, roles } = await confirmRevoked(client, config, agent);

  if (!revoked) {
    console.warn(
      `⚠️  ${stamp()}  denied, but ROLE_SET_TEXT is still held (name ${roles.perName}, wildcard ${roles.wildcard}) — not a revocation`,
    );
    return verdict;
  }

  console.log(`🔴 confirmed  no ROLE_SET_TEXT on ${HEARTBEAT_KEY}, and none via the wildcard`);

  // Before anything else. A recall has to reach the thing the owner can actually
  // see, and what they can see is a Telegram chat — an agent that keeps
  // answering after its permission was pulled has not been recalled in any sense
  // that matters to the person who pulled it.
  await gateway.stop();
  console.log(`🔴 gateway    stopped — the bot is offline`);

  // The hands go with it. A recalled agent whose broker outlived it could still
  // be asked to sign by anything left holding the token, and a transaction sent
  // after the halt line is printed is a transaction nobody can explain.
  await broker?.stop();

  console.log(
    `🔴 halted     ${config.name} · ${plural(ticks, "tick")}, ${plural(beats, "beat")} this run · last ${config.heartbeat.raw || "(never beaten)"}`,
  );
  // Nothing to write on the way out: the one record this agent could touch is
  // the one it has just been locked out of. Its silence is the symptom; the
  // owner's revocation event is the cause, and that is what the indexer reads.
  console.log("runner halted");
  process.exit(0);
}

async function main() {
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof MissingEnvError || error instanceof InvalidEnvError) {
      console.error(`❌ env        ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const account = privateKeyToAccount(env.agentKey);
  const client = createRunnerClient(env.rpcUrl);
  const walletClient = createRunnerWallet(env.rpcUrl, account);
  const prompts = new PromptCache();

  // One account, two writers. Every transaction this process sends — the
  // heartbeat on its timer and whatever the agent asks for on no timer at all —
  // goes through here, because viem reads the pending nonce at send time and
  // two overlapping sends read the same one. See serial.ts.
  const transactions = new Serializer();
  const gateway = new Gateway({
    info: (message) => console.log(`   ${stamp()}  ${message}`),
    warn: (message) => console.warn(`⚠️  ${stamp()}  ${message}`),
  });

  // ---- boot: strict ----------------------------------------------------
  let config: CapsuleConfig;
  try {
    config = await loadCapsuleConfig(client, env.capsuleName, account.address);
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) console.error(`❌ ${problem}`);
      console.error("boot failed — config");
      process.exit(1);
    }
    throw error;
  }

  const endpoint = env.endpointOverride ?? config.endpoint;

  /**
   * The wallet broker, or nothing.
   *
   * Created here rather than at the top because it reads the policy and the
   * resolver off `config`, and neither exists until the name has been loaded.
   * Both are passed as functions, not values: the tick loop reassigns `config`
   * every 30 seconds, and a broker holding a copy from boot would enforce a cap
   * its owner lowered an hour ago.
   */
  const broker =
    env.walletPort === undefined
      ? undefined
      : new WalletBroker({
          publicClient: client,
          walletClient,
          agent: account.address,
          port: env.walletPort,
          serializer: transactions,
          policy: () => config.spend,
          resolver: () => config.resolver,
          ceiling: env.spendCeiling,
          log: {
            info: (message) => console.log(`   ${stamp()}  ${message}`),
            warn: (message) => console.warn(`⚠️  ${stamp()}  ${message}`),
          },
        });

  /**
   * The balance and gas price behind `spendable`, as last read.
   *
   * `funding()` already fetches both on its own cadence and throws neither away
   * nor upward — it formats them into a log line. These two hold the raw values
   * so the spendable figure can be recomputed without a third round trip.
   */
  let lastBalance = 0n;
  let lastGasPrice: bigint | undefined;

  /**
   * What the agent is told about its own spending, as of now.
   *
   * Rebuilt on every snapshot rather than cached, because two of its four
   * numbers move without anything in this loop being notified: the policy comes
   * off the chain on the tick, and the run total moves whenever the agent
   * spends, which happens on the broker's thread and not on this one.
   */
  const spendStatus = (gasPrice: bigint | undefined): SpendStatus | undefined => {
    if (broker === undefined) return undefined;
    return {
      policy: describePolicy(config.spend),
      enabled: config.spend.cap > 0n,
      spendable:
        gasPrice === undefined
          ? undefined
          : `${Number(formatEther(spendable({ balance: lastBalance, gasPrice, beatGas: BEAT_GAS, policy: config.spend }))).toFixed(6)} ETH`,
      spentThisRun: Number(formatEther(broker.spent)).toFixed(6),
      transactions: broker.sent,
      problems: config.spend.problems,
    };
  };

  // The last credential set that loaded cleanly. Re-fetched only when the model
  // reference on chain changes, for the same reason the prompt is: the record is
  // the trigger, and an unchanged record means there is nothing to ask for.
  let credentials: RuntimeCredentials;

  // The body of `agent-prompt`, which is what actually makes this agent this
  // agent. Held here because the gateway needs it on every apply, not only the
  // first: a restart with the previous persona is a restart as the wrong agent.
  let persona: string;

  /**
   * The last balance read, and when. Seeded by the boot read below so the first
   * tick does not immediately pay for a second one. See FUNDING_REFRESH_MS.
   */
  let cash: { text: string | undefined; low: boolean; at: number } = {
    text: undefined,
    low: false,
    at: 0,
  };

  try {
    const { body } = await prompts.load({
      endpoint,
      name: config.name,
      promptRef: config.promptRef,
      signer: account,
    });
    persona = body.value;
    const shape = describeSecret(body);
    console.log(`   capsule    ${config.name}`);
    console.log(`   resolver   ${config.resolver} (discovered)`);
    console.log(`   agent      ${account.address}`);
    console.log(`   model      ${config.model}`);
    console.log(`   prompt     ${config.promptRef} · ${shape.length} chars, ${shape.digest}`);
    if (env.endpointOverride !== undefined) {
      console.log(`⚠️  endpoint   ${endpoint} (CAPSULE_ENDPOINT_OVERRIDE)`);
    }
    credentials = await fetchRuntime({ endpoint, name: config.name, signer: account });
    console.log(`   providers  ${describeCredentials(credentials)}`);

    // Strict, because this is boot. A capsule whose very first model reference
    // has no key behind it is misconfigured, and starting it would produce a
    // machine that is up, heartbeating and unable to answer a single message —
    // the most expensive way to discover a missing credential.
    const problems = runtimeProblems(config, credentials);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`❌ runtime    ${problem}`);
      console.error("boot failed — runtime");
      process.exit(1);
    }

    const gas = await funding(client, account.address);
    cash = { text: gas.ok ? gas.text : undefined, low: gas.low, at: Date.now() };
    lastBalance = gas.balance;
    lastGasPrice = gas.gasPrice;
    console.log(
      gas.low
        ? `⚠️  gas        ${gas.text} — under ${LOW_BEATS}. Fund ${account.address} or the heartbeat stops`
        : `   gas        ${gas.text}`,
    );

    // Stated at boot whether or not spending is on, and never silently. An
    // owner reading these logs to find out why their agent will not pay for
    // something must find the answer here rather than having to resolve the
    // name by hand.
    console.log(
      broker === undefined
        ? `   wallet     off — CAPSULE_WALLET=off, this capsule cannot spend by any route`
        : `   wallet     ${spendHeadline(config.spend)}`,
    );
    for (const problem of config.spend.problems) console.warn(`⚠️  wallet     ${problem}`);
    console.log(
      `   heartbeat  ${config.heartbeat.raw || "(never beaten)"} · beat every ${env.heartbeatSeconds}s, probe every ${env.tickSeconds}s`,
    );

    // Stored, not written — `apply` below is what renders it, because the file
    // has to exist complete before the gateway is spawned. Everything in it was
    // already known and already logged; until now none of it was told to the
    // one process whose job is to answer questions about this agent.
    await gateway.updateStatus({
      authorized: undefined,
      ticks: 0,
      beats: 0,
      balance: gas.ok ? gas.text : undefined,
      lowBalance: gas.low,
      heartbeat: config.heartbeat.raw,
      heartbeatSeconds: env.heartbeatSeconds,
      gatewayFailing: false,
      spend: spendStatus(lastGasPrice),
      checkedAt: new Date(),
    });
  } catch (error) {
    if (error instanceof PromptError) {
      console.error(`❌ prompt     ${error.kind} — ${error.message}`);
      console.error("boot failed — prompt");
      process.exit(1);
    }
    if (error instanceof RuntimeError) {
      console.error(`❌ runtime    ${error.kind} — ${error.message}`);
      console.error("boot failed — runtime");
      process.exit(1);
    }
    throw error;
  }

  /**
   * The teller window opens before the brain does.
   *
   * Order matters twice over: the gateway's environment carries the broker's URL
   * and token, so the broker has to be listening before `apply` builds it — and
   * a broker that cannot bind must be found now, at boot, rather than at the
   * moment an agent first tries to spend.
   *
   * A failure here is fatal, and that is the same call `runtimeProblems` makes
   * about a missing API key. Booting anyway would produce a capsule that
   * heartbeats correctly, answers messages, and refuses every transfer with an
   * error the model would report to its owner as a permission problem.
   */
  let wallet: WalletAccess | undefined;
  if (broker !== undefined) {
    try {
      await broker.start();
      wallet = { url: broker.url, token: broker.token };
      console.log(`   wallet     broker on ${broker.url} · capsule-wallet is on the agent's PATH`);
    } catch (error) {
      console.error(`❌ wallet     ${error instanceof Error ? error.message : String(error)}`);
      console.error("boot failed — wallet broker");
      process.exit(1);
    }
  }

  // The brain comes up last, once everything it needs has been proved present.
  try {
    await gateway.apply(config, credentials, persona, wallet);
    console.log(`   gateway    openclaw gateway · ${config.model}`);
    console.log(
      credentials.telegramToken === undefined
        ? `⚠️  telegram   no bot token — this capsule beats, and nobody can talk to it`
        : `   telegram   bot online${telegramIsOpen() ? " · open to anyone (CAPSULE_TELEGRAM_ALLOW_FROM is unset)" : ""}`,
    );
  } catch (error) {
    console.error(`❌ gateway    ${error instanceof Error ? error.message : String(error)}`);
    console.error("boot failed — gateway");
    process.exit(1);
  }
  console.log("runner up");

  // ---- shutdown --------------------------------------------------------
  const shutdown = new AbortController();
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      // A machine being moved between hosts must not read as a revocation.
      console.log(`\n   ${signal}    shutting down`);
      void gateway.stop();
      // Before the loop unwinds. A broker still accepting requests after the
      // gateway has been told to stop would be signing on behalf of an agent
      // that is on its way out, and the machine is usually being moved rather
      // than recalled — so this is about not leaving a transaction in flight.
      void broker?.stop();
      shutdown.abort();
    });
  }

  // ---- loop: forgiving -------------------------------------------------
  const tickMs = env.tickSeconds * 1000;
  const beatMs = env.heartbeatSeconds * 1000;
  let ticks = 0;
  let beats = 0;
  let consecutiveFailures = 0;

  // Beat on the first tick. A freshly booted agent has something to say.
  let nextBeatAt = Date.now();

  // The model reference the gateway is actually running, which is not always the
  // one on chain: a change the runtime cannot serve leaves the previous brain in
  // place. Comparing against the record instead would re-apply a broken model
  // every tick and log the same warning forever.
  let liveModel = config.model;

  // The persona the gateway is actually running, for the same reason `liveModel`
  // exists: comparing against the record instead would lose the signal the
  // moment an apply failed, leaving a capsule permanently running a persona its
  // own name stopped claiming. Compared against the ref rather than the body, so
  // a re-point to the same text is still a restart the owner asked for.
  let livePromptRef = config.promptRef;

  // The policy the last log line described, as the two raw records. Compared as
  // written rather than as parsed, so an owner correcting a typo that parsed to
  // the same cap still sees that their transaction landed.
  let liveSpend = `${config.spend.capRaw}|${config.spend.allowRaw}`;

  // The highest sequence this process has written. The per-tick config reload
  // is the only other source of it, and a node that has not caught up with our
  // own transaction yet will hand back the previous value — which would make
  // the next beat reuse a number and look, on chain, like nothing happened.
  let written = 0;

  /**
   * Tell the agent how it is doing.
   *
   * Deliberately not called on a transient failure. `authorized: false` means
   * the chain said no, and an RPC that timed out did not say no — writing that
   * into the agent's own file would have it announcing a revocation that never
   * happened. A tick that fails simply leaves the previous status in place, and
   * its `As of` stamp stops advancing, which is the truthful signal.
   */
  const snapshot = async (beat: boolean): Promise<void> => {
    if (beat || Date.now() - cash.at >= FUNDING_REFRESH_MS) {
      const fresh = await funding(client, account.address);
      cash = { text: fresh.ok ? fresh.text : undefined, low: fresh.low, at: Date.now() };
      if (fresh.ok) {
        lastBalance = fresh.balance;
        lastGasPrice = fresh.gasPrice;
      }
    }
    await gateway.updateStatus({
      authorized: true,
      ticks,
      beats,
      balance: cash.text,
      lowBalance: cash.low,
      // The record reload happens at the top of the next tick, so straight after
      // a beat the config still holds the previous value. This process knows
      // better: it is the one that wrote it.
      heartbeat: written > config.heartbeat.sequence ? heartbeatValue(written) : config.heartbeat.raw,
      heartbeatSeconds: env.heartbeatSeconds,
      gatewayFailing: gateway.failing,
      spend: spendStatus(lastGasPrice),
      checkedAt: new Date(),
    });
  };

  while (!stopping) {
    const startedAt = Date.now();
    ticks += 1;
    // A beat moves the balance, so it is the one event worth spending a fresh
    // read on rather than waiting out the refresh interval.
    const beatsBefore = beats;

    try {
      // Config first. A failure here is tolerated: the last good copy is
      // still a truthful description of this agent until proven otherwise.
      try {
        config = await loadCapsuleConfig(client, config.name, account.address);
      } catch (error) {
        console.warn(`⚠️  ${stamp()}  config unreadable, keeping the last good — ${shortRevert(error)}`);
      }

      // Only refetches when the pointer on chain actually changed.
      try {
        const { body, changed } = await prompts.load({
          endpoint: env.endpointOverride ?? config.endpoint,
          name: config.name,
          promptRef: config.promptRef,
          signer: account,
        });
        // Every tick, not only on a change: this is what the next gateway
        // restart will be handed, whatever provokes it.
        persona = body.value;
        if (changed) {
          const shape = describeSecret(body);
          console.log(
            `🔄 ${stamp()}  prompt ${config.promptRef} · ${shape.length} chars, ${shape.digest} — fetched`,
          );
        }
      } catch (error) {
        const reason = error instanceof PromptError ? error.message : shortRevert(error);
        console.warn(`⚠️  ${stamp()}  prompt unreadable, keeping the last good — ${reason}`);
      }

      // Change the record, change the brain. Same container, same machine id,
      // same wallet, same heartbeat sequence — a different model answering the
      // next message. This is the whole demo, and it is one comparison.
      //
      // Everything in here is forgiving. The owner is editing a live agent from
      // a wallet, and every way that can go wrong — a typo, a provider they
      // never stored a key for, a gateway that will not start on the new model
      // — must leave the previous brain running and say so. A capsule that dies
      // when its owner mistypes a model name is indistinguishable, on the
      // dashboard, from one that was recalled, and this project's headline claim
      // is that those two are never confused.
      // Announced, never applied: the broker reads `config.spend` through a
      // closure, so the new policy is already in force by the time this line
      // prints. What this exists for is the log — an owner who has just lowered
      // a cap needs to see the agent notice, and "nothing was printed" is
      // indistinguishable from "the record did not land".
      const spendNow = `${config.spend.capRaw}|${config.spend.allowRaw}`;
      if (spendNow !== liveSpend) {
        console.log(`🔄 ${stamp()}  wallet ${spendHeadline(config.spend)} — from the records, in force now`);
        for (const problem of config.spend.problems) console.warn(`⚠️  ${stamp()}  wallet ${problem}`);
        liveSpend = spendNow;
      }

      const modelChanged = config.model !== liveModel;
      const personaChanged = config.promptRef !== livePromptRef;

      if (modelChanged || personaChanged) {
        const what = modelChanged && personaChanged ? "brain and persona" : modelChanged ? "model" : "prompt";
        try {
          // Credentials are refetched only for a model change. A new persona is
          // served by whatever provider is already paid for, and asking again
          // would spend a signed request to be told the same thing.
          const next = modelChanged
            ? await fetchRuntime({
                endpoint: env.endpointOverride ?? config.endpoint,
                name: config.name,
                signer: account,
              })
            : credentials;

          const problems = runtimeProblems(config, next);
          if (problems.length > 0) {
            for (const problem of problems) {
              console.warn(`⚠️  ${stamp()}  ${what} not applied — ${problem}`);
            }
            console.warn(`⚠️  ${stamp()}  still running ${liveModel} · ${livePromptRef}`);
          } else {
            // One restart, whichever of the two changed, and both are carried
            // in: the config document and AGENTS.md are rewritten together, so
            // a tick that sees both changes cannot leave the gateway holding
            // one of them.
            await gateway.apply(config, next, persona);
            credentials = next;
            if (modelChanged) {
              console.log(
                `🔄 ${stamp()}  model ${liveModel} → ${config.model} · gateway restarted — this is a different brain now`,
              );
              liveModel = config.model;
            }
            if (personaChanged) {
              console.log(
                `🔄 ${stamp()}  prompt ${livePromptRef} → ${config.promptRef} · gateway restarted — this is a different agent now`,
              );
              livePromptRef = config.promptRef;
            }
          }
        } catch (error) {
          const reason = error instanceof RuntimeError ? error.message : shortRevert(error);
          console.warn(
            `⚠️  ${stamp()}  ${what} not applied, still running ${liveModel} · ${livePromptRef} — ${reason}`,
          );
        }
      }

      const sequence = Math.max(config.heartbeat.sequence, written) + 1;

      if (Date.now() >= nextBeatAt) {
        // Queued, so a transaction the agent asked for cannot land on the same
        // nonce. `submit` re-throws whatever the job threw, so every error this
        // path already classifies — a revocation, an empty wallet — arrives at
        // `reckon` exactly as it did before there was a queue.
        const result = await transactions.submit(() =>
          writeHeartbeat({
            publicClient: client,
            walletClient,
            config,
            sequence,
          }),
        );
        written = sequence;
        beats += 1;
        nextBeatAt = Date.now() + beatMs;
        console.log(
          `💓 ${stamp()}  ${result.value} · block ${result.blockNumber} · ${count(Number(result.gasUsed))} gas · ${result.hash}`,
        );
      } else {
        // Between beats, the free call. Same modifier, same revert, no gas.
        await probeHeartbeat({
          publicClient: client,
          config,
          agent: account.address,
          sequence,
        });
      }

      consecutiveFailures = 0;
      // Authorized is not the same as working, and this is the one line anybody
      // reads. A capsule whose gateway will not start is fully authorized and
      // completely useless, and saying only "authorized" here is how that goes
      // unnoticed for the length of a demo.
      const brain = gateway.failing ? " · ⚠️ gateway down" : "";
      console.log(`✅ ${stamp()}  tick ${ticks} · authorized${brain} · ${secs(Date.now() - startedAt)}`);
      await snapshot(beats !== beatsBefore);
    } catch (error) {
      const verdict = await reckon({
        error,
        client,
        config,
        agent: account.address,
        ticks,
        beats,
        gateway,
        broker,
      });

      if (verdict === "unfunded") {
        // Authorized, just broke. writeHeartbeat simulates before it sends, and
        // the simulation runs the same EAC modifier a revoked agent fails — so
        // reaching an insufficient-funds error is itself proof the permission
        // is held. Log the tick as authorized rather than swallowing it, or the
        // counter appears to skip and the log looks like it lost something.
        console.log(
          `✅ ${stamp()}  tick ${ticks} · authorized, beat skipped · ${secs(Date.now() - startedAt)}`,
        );
        // Back off a full interval rather than saying so every tick, and do not
        // spend the failure budget: this agent is working exactly as well as an
        // unfunded agent can, and killing it would turn a top-up into a redeploy.
        nextBeatAt = Date.now() + beatMs;
        consecutiveFailures = 0;
        // Forced, because the balance is the whole story here and the agent
        // should be able to say so when its owner asks why it went quiet.
        await snapshot(true);
      } else {
        consecutiveFailures += 1;
        if (consecutiveFailures >= FAILURE_BUDGET) {
          // Said this loudly on purpose: on a dashboard, a silent agent and a
          // revoked one look identical, and the logs are the only place the
          // difference survives. Exit 1 so the platform restarts it — the chain
          // may well be back by then.
          console.error(
            `❌ giving up after ${FAILURE_BUDGET} consecutive failures — this is NOT a revocation`,
          );
          process.exit(1);
        }
      }
    }

    // Cadence from the start of the tick, not the end, so a slow probe does
    // not push every later tick further out. A beat waits for its receipt and
    // can outrun the tick entirely, which is correct: the next tick starts as
    // soon as this one finishes rather than piling up behind it.
    const elapsed = Date.now() - startedAt;
    await sleep(Math.max(MIN_SLEEP_MS, tickMs - elapsed), shutdown.signal);
  }

  await gateway.stop();
  await broker?.stop();
  const moved = broker === undefined || broker.sent === 0 ? "" : ` · ${plural(broker.sent, "transaction")} sent`;
  console.log(`   stopped    ${plural(ticks, "tick")} · ${plural(beats, "beat")}${moved}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`❌ runner crashed — ${shortRevert(error)}`);
  process.exit(1);
});
