/**
 * Writes exactly one heartbeat and stops.
 *
 *   npm run heartbeat
 *
 * A real Sepolia transaction, paid for by the agent's own key. Reads the
 * current beat off the name first, so the sequence continues across processes
 * rather than restarting — the count lives on chain, not in memory.
 */
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { createRunnerClient, createRunnerWallet } from "./chain.js";
import { ConfigError, loadCapsuleConfig } from "./config.js";
import { InvalidEnvError, MissingEnvError, loadEnv } from "./env.js";
import { HeartbeatRevertedError, heartbeatValue, writeHeartbeat } from "./heartbeat.js";

const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function main() {
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof MissingEnvError || error instanceof InvalidEnvError) {
      console.error(`❌ env       ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const account = privateKeyToAccount(env.agentKey);
  const publicClient = createRunnerClient(env.rpcUrl);
  const walletClient = createRunnerWallet(env.rpcUrl, account);

  let config;
  try {
    config = await loadCapsuleConfig(publicClient, env.capsuleName, account.address);
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) console.error(`❌ ${problem}`);
      console.error("config failed");
      process.exit(1);
    }
    throw error;
  }

  const sequence = config.heartbeat.sequence + 1;
  const value = heartbeatValue(sequence);

  console.log(`   capsule    ${config.name}`);
  console.log(`   resolver   ${config.resolver} (discovered)`);
  console.log(`   writing    setText(agent.heartbeat, "${value}") as ${account.address}`);

  try {
    const result = await writeHeartbeat({ publicClient, walletClient, config, sequence });
    console.log(`✅ sent       ${result.hash}`);
    console.log(
      `✅ mined      block ${result.blockNumber} · ${result.gasUsed.toLocaleString("en-US")} gas`,
    );
    console.log(
      `✅ heartbeat  ${config.heartbeat.raw === "" ? "(never beaten)" : config.heartbeat.raw} → ${result.value}`,
    );
  } catch (error) {
    if (error instanceof HeartbeatRevertedError) {
      console.error(`❌ heartbeat  reverted on chain — ${error.hash}`);
      process.exit(1);
    }
    // Left raw on purpose. Task 6 is where a denied write stops being a crash
    // and becomes a decision, and it needs to see the error as it arrives.
    throw error;
  }
}

main().catch((error) => {
  console.error(`❌ heartbeat failed — ${why(error)}`);
  process.exit(1);
});
