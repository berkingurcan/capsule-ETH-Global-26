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
import { formatEther, zeroAddress } from "viem";
import { ETH_REGISTRY, createServerClient, minterAbi, registryAbi } from "../lib/capsule/chain";
import { encodeParent } from "../lib/capsule/parent";
import { loadProvisionerEnv, loadServerEnv, InvalidEnvError, MissingEnvError } from "../lib/capsule/env";
import { getApp } from "../lib/capsule/fly";

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

  // --- The minter can still mint under the default parent ------------------
  // The worst failure in the system is a user paying gas for a mint that reverts
  // because a role was revoked, so it is checked here, before a deploy.
  //
  // Scoped to `CAPSULE_PARENT_NAME`. One minter now serves every name whose owner
  // connected it, and this deployment cannot be responsible for those: their
  // owners can revoke the minter's roles whenever they like, and their doing so
  // is not a problem with this deployment. It IS a problem if the demo's own
  // front door is broken, which is what this asks about.
  try {
    const parent = encodeParent(env.defaultParentName);
    const registry = await client.readContract({
      address: ETH_REGISTRY,
      abi: registryAbi,
      functionName: "getSubregistry",
      args: [parent.label],
    });
    if (registry === zeroAddress) {
      record("minter", false, `${parent.name} has no subregistry, so nothing can mint under it`);
    } else {
      const [connected, registrar, resolverRoles] = await client.readContract({
        address: env.minterAddress,
        abi: minterAbi,
        functionName: "readiness",
        args: [registry, env.minterAddress],
      });
      if (!connected) record("minter", false, `${parent.name} is not connected — run ConnectParent.s.sol`);
      else if (!registrar) record("minter", false, `the minter lacks ROLE_REGISTRAR on ${parent.name}`);
      else if (!resolverRoles) record("minter", false, `the minter lacks resolver roles on ${parent.name}`);
      else record("minter", true, `${env.minterAddress} can mint under ${parent.name}`);
    }
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

  // --- The funder ---------------------------------------------------------
  //
  // Reported, not required. `CAPSULE_FUNDER_KEY` is loaded by the provision
  // route alone, so a deployment that only mints is correctly configured
  // without it — and one that means to provision wants to know before a user
  // does that its wallet is empty.
  try {
    const provisioner = loadProvisionerEnv();
    const balance = await client.getBalance({ address: provisioner.funderAddress });
    const capsules = balance / provisioner.agentFundingWei;
    record(
      "funder",
      capsules > 0n,
      capsules > 0n
        ? `${provisioner.funderAddress} · ${formatEther(balance)} ETH · ${capsules} capsule(s) at ${formatEther(provisioner.agentFundingWei)} each`
        : `${provisioner.funderAddress} holds ${formatEther(balance)} ETH — not enough to fund one agent`,
    );
  } catch (error) {
    if (error instanceof MissingEnvError && error.varName === "CAPSULE_FUNDER_KEY") {
      console.log("");
      console.log("  note      CAPSULE_FUNDER_KEY is unset — minting works, provisioning answers 503");
    } else {
      record("funder", false, reason(error));
    }
  }

  // --- Informational ------------------------------------------------------
  console.log("");
  console.log(`  parent    ${env.defaultParentName} (default; others connect at /connect)`);
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
