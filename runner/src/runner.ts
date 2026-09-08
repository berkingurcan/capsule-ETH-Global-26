/**
 * The runner.
 *
 * Given one thing — its own ENS name — it finds out what it is, starts the agent that
 * name describes, checks continuously that it is still allowed to be that, and shuts the
 * agent down when the answer becomes no.
 *
 * It is a supervisor, not an agent. The agent is an OpenClaw gateway talking to the
 * owner's Telegram bot; everything that gateway is comes from records under the name and
 * from credentials the name is entitled to fetch. See openclaw.ts.
 *
 * Boot is strict and the loop is forgiving. A misconfigured agent must never start; a
 * running agent must not die because an RPC hiccuped. Exactly one thing is fatal at
 * runtime, and it is the owner revoking the agent's write permission on its own name.
 *
 * Two cadences, and the difference is money:
 *
 *   TICK_SECONDS       a free eth_call asking the resolver whether the write would be
 *                      allowed. This is how a revocation is caught in seconds.
 *   HEARTBEAT_SECONDS  a real transaction writing `agent-heartbeat`. This is the liveness
 *                      signal anyone else can see — the dashboard, the subgraph, the
 *                      owner. Three a day by default; see env.ts for the arithmetic.
 *
 * The probe alone would be cheaper and would still catch the kill switch. It would also
 * leave nothing on chain, and a liveness signal only the agent can observe is not one.
 */
import "dotenv/config";
import { formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRunnerClient, createRunnerWallet } from "./chain.js";
import { ConfigError, loadCapsuleConfig, type CapsuleConfig } from "./config.js";
import { InvalidEnvError, MissingEnvError, loadEnv } from "./env.js";
import { shortRevert } from "./errors.js";
import { classifyHeartbeatFailure, confirmRevoked } from "./halt.js";
import { probeHeartbeat, writeHeartbeat } from "./heartbeat.js";
import { OpenClawSupervisor, RuntimeConfigError } from "./openclaw.js";
import { PromptCache, PromptError } from "./prompt.js";
import { KEY_HEARTBEAT } from "./records.js";
import { RuntimeError, fetchRuntimeCredentials, type RuntimeCredentials } from "./runtime.js";
import { describeSecret } from "./secret.js";

/** Consecutive transient failures before giving up. Reset by any success. */
const FAILURE_BUDGET = 5;

/** A slow chain must never turn the cadence into a busy loop. */
const MIN_SLEEP_MS = 5_000;

/** Below this, the next heartbeat will fail for want of gas. Warned about, not fatal. */
const LOW_BALANCE_WEI = 2_000_000_000_000_000n; // 0.002 ETH — roughly 40 writes at 1 gwei

const stamp = () => new Date().toISOString().slice(11, 19);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

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
  const wallet = createRunnerWallet(env.rpcUrl, account);
  const prompts = new PromptCache();
  const openclaw = new OpenClawSupervisor();

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
  let credentials: RuntimeCredentials;

  try {
    const { body } = await prompts.load({
      endpoint,
      name: config.name,
      promptRef: config.promptRef,
      signer: account,
    });
    credentials = await fetchRuntimeCredentials({ endpoint, name: config.name, signer: account });

    const shape = describeSecret(body);
    console.log(`   capsule    ${config.name}`);
    console.log(`   resolver   ${config.resolver} (discovered)`);
    console.log(`   agent      ${account.address}`);
    console.log(`   model      ${config.model} · ${config.runtime}`);
    console.log(`   prompt     ${config.promptRef} · ${shape.length} chars, ${shape.digest}`);
    if (config.webEndpoint !== "") console.log(`   telegram   ${config.webEndpoint}`);
    if (env.endpointOverride !== undefined) {
      console.log(`⚠️  endpoint   ${endpoint} (CAPSULE_ENDPOINT_OVERRIDE)`);
    }

    // The agent pays for its own heartbeats now. Say the balance out loud at boot: an
    // unfunded agent will halt eight hours from now with a failure that has nothing to
    // do with permissions, and nobody will be watching when it does.
    const balance = await client.getBalance({ address: account.address });
    const funded = balance >= LOW_BALANCE_WEI;
    console.log(
      `${funded ? "  " : "⚠️"} balance    ${formatEther(balance)} ETH${funded ? "" : " — too low to keep beating"}`,
    );
    console.log(`   tick       ${env.tickSeconds}s probe · ${env.heartbeatSeconds}s heartbeat`);

    await openclaw.apply({ config, credentials, prompt: body });
    console.log("runner up");
  } catch (error) {
    // Every boot failure names its own kind, because from a dashboard they look alike.
    if (error instanceof PromptError) {
      console.error(`❌ prompt     ${error.kind} — ${error.message}`);
      console.error("boot failed — prompt");
      process.exit(1);
    }
    if (error instanceof RuntimeError) {
      console.error(`❌ runtime    ${error.kind} — ${error.message}`);
      console.error("boot failed — credentials");
      process.exit(1);
    }
    if (error instanceof RuntimeConfigError) {
      console.error(`❌ openclaw   ${error.message}`);
      console.error("boot failed — runtime configuration");
      process.exit(1);
    }
    throw error;
  }

  // ---- shutdown --------------------------------------------------------
  const shutdown = new AbortController();
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      // A machine being moved between hosts must not read as a revocation.
      console.log(`\n   ${signal}    shutting down`);
      shutdown.abort();
    });
  }

  // ---- loop: forgiving -------------------------------------------------
  const tickMs = env.tickSeconds * 1000;
  const heartbeatMs = env.heartbeatSeconds * 1000;
  let ticks = 0;
  let beats = 0;
  let consecutiveFailures = 0;

  // Beat immediately on the first pass. The first heartbeat after a boot is the one that
  // tells the dashboard this agent came back, and waiting eight hours to say so would
  // make every restart look like an outage.
  let nextBeatAt = Date.now();

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
        // Cheap when nothing moved: apply() digests the rendered config and the workspace
        // files and returns without touching the gateway if they are unchanged. So this
        // runs every tick and restarts the bot only when a record actually changed.
        await openclaw.apply({ config, credentials, prompt: body });
      } catch (error) {
        const reason =
          error instanceof PromptError || error instanceof RuntimeConfigError
            ? error.message
            : shortRevert(error);
        console.warn(`⚠️  ${stamp()}  runtime not reconfigured, keeping the last good — ${reason}`);
      }

      // The only question that can end the process, asked for free every tick.
      await probeHeartbeat({
        publicClient: client,
        config,
        agent: account.address,
        sequence: config.heartbeat.sequence + 1,
      });

      // And the one that costs gas, asked on its own much slower schedule.
      if (Date.now() >= nextBeatAt) {
        const result = await writeHeartbeat({
          publicClient: client,
          walletClient: wallet,
          config,
          sequence: config.heartbeat.sequence + 1,
        });
        beats += 1;
        nextBeatAt = Date.now() + heartbeatMs;
        console.log(
          `💓 ${stamp()}  ${result.value} · block ${result.blockNumber} · ${result.gasUsed} gas · ${result.hash}`,
        );
      }

      consecutiveFailures = 0;
      console.log(`✅ ${stamp()}  tick ${ticks} · authorized · ${secs(Date.now() - startedAt)}`);
    } catch (error) {
      if (classifyHeartbeatFailure(error) === "revoked") {
        console.log(`🔴 ${stamp()}  denied — setText(${KEY_HEARTBEAT}) refused by the resolver`);

        // The revert names the name-level resource whichever key was denied,
        // so ask the role table directly before concluding anything.
        const { revoked, roles } = await confirmRevoked(client, config, account.address);

        if (revoked) {
          console.log(`🔴 confirmed  no ROLE_SET_TEXT on ${KEY_HEARTBEAT}, and none via the wildcard`);

          // Stop the gateway before saying anything else. Recall has to reach the surface
          // the owner can actually see, and that surface is a Telegram chat — an agent
          // that keeps answering for the seconds it takes us to exit is a kill switch
          // that does not work.
          await openclaw.stop();
          console.log(`🔴 stopped    openclaw gateway`);
          console.log(
            `🔴 halted     ${config.name} · ${ticks} ticks, ${beats} heartbeats this run`,
          );
          console.log("runner halted");
          process.exit(0);
        }

        console.warn(
          `⚠️  ${stamp()}  denied, but ROLE_SET_TEXT is still held (name ${roles.perName}, wildcard ${roles.wildcard}) — not a revocation`,
        );
      } else {
        console.warn(`⚠️  ${stamp()}  tick ${ticks} failed — ${shortRevert(error)}`);
      }

      consecutiveFailures += 1;
      if (consecutiveFailures >= FAILURE_BUDGET) {
        // Said this loudly on purpose: on a dashboard, a silent agent and a
        // revoked one look identical, and the logs are the only place the
        // difference survives. Exit 1 so the platform restarts it — the chain
        // may well be back by then.
        console.error(
          `❌ giving up after ${FAILURE_BUDGET} consecutive failures — this is NOT a revocation`,
        );
        await openclaw.stop();
        process.exit(1);
      }
    }

    // Cadence from the start of the tick, not the end, so a slow probe does
    // not push every later tick further out.
    const elapsed = Date.now() - startedAt;
    await sleep(Math.max(MIN_SLEEP_MS, tickMs - elapsed), shutdown.signal);
  }

  await openclaw.stop();
  console.log(`   stopped    ${ticks} ticks, ${beats} heartbeats`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`❌ runner crashed — ${shortRevert(error)}`);
  process.exit(1);
});
