/**
 * Reads one text record off the runner's own name and prints it.
 *
 *   npm run resolve                  # agent.model
 *   npm run resolve agent.heartbeat  # any key
 *
 * Exists so the read path can be exercised without the loop around it.
 */
import "dotenv/config";
import { createRunnerClient } from "./chain.js";
import { InvalidEnvError, MissingEnvError, loadEnv } from "./env.js";
import { encodeName, readText } from "./resolve.js";

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

  const key = process.argv[2] ?? "agent.model";
  const { name, node, dnsName } = encodeName(env.capsuleName);
  const client = createRunnerClient(env.rpcUrl);

  console.log(`   capsule    ${name}`);
  console.log(`   node       ${node}`);
  console.log(`   dns        ${dnsName}`);

  const { value, resolver } = await readText(client, name, key);

  // An unset key reads back as "". Say so rather than printing a blank line
  // and leaving the reader to wonder whether the call even happened.
  console.log(`${value === "" ? "⚪️" : "✅"} ${key.padEnd(10)} ${value === "" ? "(not set)" : value}`);
  console.log(`✅ resolver   ${resolver}`);
}

main().catch((error) => {
  console.error(`❌ resolve failed — ${why(error)}`);
  process.exit(1);
});
