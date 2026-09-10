/**
 * Prints the capsule the runner would boot with.
 *
 *   npm run config
 *
 * Same three-link identity chain the runner enforces:
 *   AGENT_KEY -> AGENT_ADDRESS (preflight) -> addr on the name (here)
 */
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { createRunnerClient } from "./chain.js";
import { ConfigError, loadCapsuleConfig } from "./config.js";
import { spendHeadline } from "./policy.js";
import { InvalidEnvError, MissingEnvError, loadEnv } from "./env.js";

const short = (address: string) => `${address.slice(0, 10)}…${address.slice(-6)}`;
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
  const client = createRunnerClient(env.rpcUrl);

  let config;
  try {
    config = await loadCapsuleConfig(client, env.capsuleName, account.address);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`   capsule    ${env.capsuleName}`);
      // Every problem at once. Fixing one record per run, four runs deep, is
      // its own kind of 2am.
      for (const problem of error.problems) console.error(`❌ ${problem}`);
      console.error("config failed");
      process.exit(1);
    }
    throw error;
  }

  const next = config.heartbeat.sequence + 1;
  console.log(`   capsule    ${config.name}`);
  console.log(`   resolver   ${config.resolver}`);
  console.log(`✅ addr       ${short(config.agent)} (matches AGENT_ADDRESS)`);
  console.log(`✅ model      ${config.model}`);
  console.log(`✅ endpoint   ${config.endpoint}`);
  // The pointer is safe to print. Whatever it resolves to in task 4 is not:
  // stdout is Fly's log stream, and the fleet dashboard reads that stream.
  console.log(`✅ prompt     ${config.promptRef} → (pointer, resolved in task 4)`);
  console.log(
    `✅ heartbeat  ${config.heartbeat.raw === "" ? "(never beaten)" : config.heartbeat.raw} → next beat-${next}`,
  );
  // Reported whether or not it is on, and with the mark it deserves rather than
  // a tick: a capsule that cannot spend is correctly configured, not broken.
  console.log(`${config.spend.cap > 0n ? "✅" : "  "} wallet     ${spendHeadline(config.spend)}`);
  for (const problem of config.spend.problems) console.warn(`⚠️  wallet     ${problem}`);
  console.log("config loaded");
}

main().catch((error) => {
  console.error(`❌ config crashed — ${why(error)}`);
  process.exit(1);
});
