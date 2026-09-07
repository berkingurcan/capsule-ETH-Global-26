/**
 * Environment gate for the Capsule backend.
 *
 * Same shape as runner/src/preflight.ts and for the same reason: collect every
 * result, print the whole picture, then decide once. A gate that exits on the
 * first failure makes you run it five times to find five problems.
 *
 * Run it before every deploy, and after every environment change.
 *
 *   npm run preflight
 */
import { neon } from "@neondatabase/serverless";
import { createServerClient, minterAbi } from "../lib/capsule/chain.js";
import { loadServerEnv, InvalidEnvError, MissingEnvError } from "../lib/capsule/env.js";
import { getApp } from "../lib/capsule/fly.js";

type Check = { name: string; ok: boolean; detail: string };

const checks: Check[] = [];
const record = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail });
};

function reason(error: unknown): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);
}

async function main() {
  let env;
  try {
    env = loadServerEnv();
  } catch (error) {
    // Config errors are the one thing worth failing fast on: every check below
    // needs a value this would have produced.
    if (error instanceof MissingEnvError || error instanceof InvalidEnvError) {
      console.error(`\n  env  ${error.message}`);
      console.error(`\n  copy .env.local.example to .env.local and fill it in.\n`);
      process.exit(1);
    }
    throw error;
  }
  record("env", true, "all required variables present and well-formed");

  // --- Sepolia -----------------------------------------------------------
  const client = createServerClient(env.rpcUrl);
  try {
    const block = await client.getBlockNumber();
    record("rpc", true, `sepolia block ${block}`);
  } catch (error) {
    record("rpc", false, `SEPOLIA_RPC_URL unreachable — ${reason(error)}`);
  }

  // --- The minter still holds its resolver roles --------------------------
  // Reverts with MissingResolverRoles if someone revoked them. A paid user
  // hitting this is the worst failure in the system, so it is checked here.
  try {
    // A view function, so this is an eth_call: free, and it reverts with
    // MissingResolverRoles exactly as a real mint would.
    await client.readContract({
      address: env.minterAddress,
      abi: minterAbi,
      functionName: "checkResolverRoles",
    });
    record("minter", true, `${env.minterAddress} holds its resolver root roles`);
  } catch (error) {
    record("minter", false, `${env.minterAddress} — ${reason(error)}`);
  }

  // --- Neon ---------------------------------------------------------------
  try {
    const sql = neon(env.databaseUrl);
    const rows = (await sql`select version() as version`) as { version: string }[];
    const version = rows[0]?.version ?? "unknown";
    record("database", true, version.split(" ").slice(0, 2).join(" "));
  } catch (error) {
    record("database", false, `DATABASE_URL — ${reason(error)}`);
  }

  // --- Fly ----------------------------------------------------------------
  try {
    const app = await getApp({ token: env.flyApiToken, appName: env.flyAppName });
    record("fly", true, `app ${app.name} (${app.status}) visible to this token`);
  } catch (error) {
    record("fly", false, reason(error));
  }

  // --- Informational ------------------------------------------------------
  console.log("");
  console.log(`  parent    ${env.parentName}`);
  console.log(`  image     ${env.runnerImage}`);
  console.log(`  region    ${env.flyRegion}`);
  console.log(`  endpoint  ${env.publicUrl}`);
  console.log("");

  let failed = 0;
  for (const c of checks) {
    if (c.ok) {
      console.log(`  ok    ${c.name.padEnd(9)} ${c.detail}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${c.name.padEnd(9)} ${c.detail}`);
    }
  }
  console.log("");

  if (failed > 0) {
    console.error(`${failed} of ${checks.length} checks failed.\n`);
    process.exit(1);
  }
  console.log(`all ${checks.length} checks passed.\n`);
}

main().catch((error) => {
  console.error(`\npreflight crashed: ${reason(error)}\n`);
  process.exit(1);
});
