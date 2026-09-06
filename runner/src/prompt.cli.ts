/**
 * Fetches the prompt the name points at, and prints nothing that matters.
 *
 *   npm run prompt
 *
 * Needs the dev service running, or CAPSULE_ENDPOINT_OVERRIDE pointed at one:
 *   npm run dev:prompt-server
 */
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { createRunnerClient } from "./chain.js";
import { ConfigError, loadCapsuleConfig } from "./config.js";
import { InvalidEnvError, MissingEnvError, loadEnv } from "./env.js";
import { PromptCache, PromptError } from "./prompt.js";
import { describeSecret } from "./secret.js";

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
      for (const problem of error.problems) console.error(`❌ ${problem}`);
      console.error("config failed");
      process.exit(1);
    }
    throw error;
  }

  console.log(`   capsule    ${config.name}`);

  // An override is announced every time it is used. It is a development
  // convenience, not a fallback, and it must never be quiet.
  const endpoint = env.endpointOverride ?? config.endpoint;
  if (env.endpointOverride !== undefined) {
    console.log(`⚠️  endpoint   ${endpoint} (CAPSULE_ENDPOINT_OVERRIDE)`);
    console.log(`   on chain   ${config.endpoint}`);
  } else {
    console.log(`✅ endpoint   ${endpoint}`);
  }

  const cache = new PromptCache();
  const args = { endpoint, name: config.name, promptRef: config.promptRef, signer: account };

  try {
    const { body } = await cache.load(args);
    const { length, digest } = describeSecret(body);
    console.log(`✅ signed     capsule-prompt-fetch as ${account.address}`);
    console.log(`✅ prompt     ${config.promptRef} → ${length} chars, ${digest}`);

    // Proof the wrapper holds, through the three paths that leak in practice:
    // template interpolation, util.inspect (what console.log uses on objects),
    // and JSON.stringify.
    console.log(`   interp     ${body}`);
    console.log("   inspect   ", body);
    console.log(`   json       ${JSON.stringify({ prompt: body })}`);

    // A second load with the same pointer must not touch the network.
    const again = await cache.load(args);
    console.log(`✅ cache      second load refetched: ${again.changed}`);
    console.log("prompt loaded");
  } catch (error) {
    if (error instanceof PromptError) {
      console.error(`❌ prompt     ${error.kind}${error.status ? ` (${error.status})` : ""} — ${error.message}`);
      console.error("prompt failed");
      process.exit(1);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`❌ prompt crashed — ${why(error)}`);
  process.exit(1);
});
