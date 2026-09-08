/**
 * The runner.
 *
 * Given one thing — its own ENS name — it finds out what it is, checks every
 * tick that it is still allowed to be that, and shuts itself down when the
 * answer becomes no.
 *
 * Boot is strict and the loop is forgiving. A misconfigured agent must never
 * start; a running agent must not die because an RPC hiccuped. Exactly one
 * thing is fatal at runtime, and it is the owner revoking the agent's write
 * permission on its own name.
 *
 * No transactions. The authorization probe is an eth_call, so an agent needs a
 * key and nothing else — no funded wallet, and no funding pipeline behind it.
 */
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { createRunnerClient } from "./chain.js";
import { ConfigError, loadCapsuleConfig, type CapsuleConfig } from "./config.js";
import { InvalidEnvError, MissingEnvError, loadEnv } from "./env.js";
import { shortRevert } from "./errors.js";
import { classifyHeartbeatFailure, confirmRevoked } from "./halt.js";
import { probeHeartbeat } from "./heartbeat.js";
import { HEARTBEAT_KEY } from "./records.js";
import { PromptCache, PromptError } from "./prompt.js";
import { describeSecret } from "./secret.js";

/** Consecutive transient failures before giving up. Reset by any success. */
const FAILURE_BUDGET = 5;

/** A slow chain must never turn the cadence into a busy loop. */
const MIN_SLEEP_MS = 5_000;

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
  const prompts = new PromptCache();

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
    console.log(`   mode       read-only · no transactions, no gas`);
    console.log(`   tick       ${env.tickSeconds}s`);
    console.log("runner up");
  } catch (error) {
    if (error instanceof PromptError) {
      console.error(`❌ prompt     ${error.kind} — ${error.message}`);
      console.error("boot failed — prompt");
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
  let ticks = 0;
  let consecutiveFailures = 0;

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

      // The only question that can end the process.
      await probeHeartbeat({
        publicClient: client,
        config,
        agent: account.address,
        sequence: config.heartbeat.sequence + 1,
      });

      consecutiveFailures = 0;
      console.log(`✅ ${stamp()}  tick ${ticks} · authorized · ${secs(Date.now() - startedAt)}`);
    } catch (error) {
      if (classifyHeartbeatFailure(error) === "revoked") {
        console.log(`🔴 ${stamp()}  denied — setText(${HEARTBEAT_KEY}) refused by the resolver`);

        // The revert names the name-level resource whichever key was denied,
        // so ask the role table directly before concluding anything.
        const { revoked, roles } = await confirmRevoked(client, config, account.address);

        if (revoked) {
          console.log(`🔴 confirmed  no ROLE_SET_TEXT on ${HEARTBEAT_KEY}, and none via the wildcard`);
          console.log(`🔴 halted     ${config.name} · ${ticks} ticks this run · 0 transactions`);
          // Nothing to write on the way out: the one record this agent could
          // touch is the one it has just been locked out of. Its silence is
          // the symptom; the owner's revocation event is the cause, and that
          // is what build step 5 indexes.
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
        process.exit(1);
      }
    }

    // Cadence from the start of the tick, not the end, so a slow probe does
    // not push every later tick further out.
    const elapsed = Date.now() - startedAt;
    await sleep(Math.max(MIN_SLEEP_MS, tickMs - elapsed), shutdown.signal);
  }

  console.log(`   stopped    ${ticks} ticks · 0 transactions`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`❌ runner crashed — ${shortRevert(error)}`);
  process.exit(1);
});
