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
import { LOW_BEATS, probeHeartbeat, readFunding, writeHeartbeat } from "./heartbeat.js";
import { HEARTBEAT_KEY } from "./records.js";
import { Gateway, runtimeProblems } from "./openclaw.js";
import { PromptCache, PromptError } from "./prompt.js";
import { RuntimeError, describeCredentials, fetchRuntime, type RuntimeCredentials } from "./runtime.js";
import { describeSecret } from "./secret.js";

/** Consecutive transient failures before giving up. Reset by any success. */
const FAILURE_BUDGET = 5;

/** A slow chain must never turn the cadence into a busy loop. */
const MIN_SLEEP_MS = 5_000;

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
): Promise<{ text: string; low: boolean }> {
  try {
    const { balance, gasPrice, beats, low } = await readFunding(client, agent);
    return { text: `${eth(balance)} · ~${count(beats)} beats at ${gwei(gasPrice)}`, low };
  } catch (error) {
    return { text: `balance unreadable — ${shortRevert(error)}`, low: false };
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
}): Promise<HeartbeatVerdict> {
  const { error, client, config, agent, ticks, beats, gateway } = args;
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

  // The last credential set that loaded cleanly. Re-fetched only when the model
  // reference on chain changes, for the same reason the prompt is: the record is
  // the trigger, and an unchanged record means there is nothing to ask for.
  let credentials: RuntimeCredentials;

  try {
    const { body } = await prompts.load({
      endpoint,
      name: config.name,
      promptRef: config.promptRef,
      signer: account,
    });
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
    console.log(
      gas.low
        ? `⚠️  gas        ${gas.text} — under ${LOW_BEATS}. Fund ${account.address} or the heartbeat stops`
        : `   gas        ${gas.text}`,
    );
    console.log(
      `   heartbeat  ${config.heartbeat.raw || "(never beaten)"} · beat every ${env.heartbeatSeconds}s, probe every ${env.tickSeconds}s`,
    );
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

  // The brain comes up last, once everything it needs has been proved present.
  try {
    await gateway.apply(config, credentials);
    console.log(`   gateway    openclaw gateway · ${config.model}`);
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

  // The highest sequence this process has written. The per-tick config reload
  // is the only other source of it, and a node that has not caught up with our
  // own transaction yet will hand back the previous value — which would make
  // the next beat reuse a number and look, on chain, like nothing happened.
  let written = 0;

  while (!stopping) {
    const startedAt = Date.now();
    ticks += 1;

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
        if (changed) {
          const shape = describeSecret(body);
          console.log(
            `🔄 ${stamp()}  prompt ${config.promptRef} · ${shape.length} chars, ${shape.digest} — this is a different agent now`,
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
      if (config.model !== liveModel) {
        try {
          const next = await fetchRuntime({
            endpoint: env.endpointOverride ?? config.endpoint,
            name: config.name,
            signer: account,
          });

          const problems = runtimeProblems(config, next);
          if (problems.length > 0) {
            for (const problem of problems) {
              console.warn(`⚠️  ${stamp()}  model ${config.model} not applied — ${problem}`);
            }
            console.warn(`⚠️  ${stamp()}  still running ${liveModel}`);
          } else {
            await gateway.apply(config, next);
            credentials = next;
            console.log(
              `🔄 ${stamp()}  model ${liveModel} → ${config.model} · gateway restarted — this is a different brain now`,
            );
            liveModel = config.model;
          }
        } catch (error) {
          const reason = error instanceof RuntimeError ? error.message : shortRevert(error);
          console.warn(
            `⚠️  ${stamp()}  model ${config.model} not applied, still running ${liveModel} — ${reason}`,
          );
        }
      }

      const sequence = Math.max(config.heartbeat.sequence, written) + 1;

      if (Date.now() >= nextBeatAt) {
        const result = await writeHeartbeat({
          publicClient: client,
          walletClient,
          config,
          sequence,
        });
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
      console.log(`✅ ${stamp()}  tick ${ticks} · authorized · ${secs(Date.now() - startedAt)}`);
    } catch (error) {
      const verdict = await reckon({
        error,
        client,
        config,
        agent: account.address,
        ticks,
        beats,
        gateway,
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
  console.log(`   stopped    ${plural(ticks, "tick")} · ${plural(beats, "beat")}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`❌ runner crashed — ${shortRevert(error)}`);
  process.exit(1);
});
