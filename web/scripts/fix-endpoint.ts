/**
 * Repairs `agent-endpoint[capsule]` on names minted before the `/api` fix.
 *
 * Names minted before that change carry the site origin where the API root
 * belongs — `https://…vercel.app` rather than `https://…vercel.app/api`. The
 * runner appends `/prompt/:ref` and `/runtime` to whatever the record says
 * (runner/src/prompt.ts, runner/src/runtime.ts), so those agents ask Next for a
 * page that does not exist, take a 404, and report it as "no prompt stored" —
 * an error that names the prompt while the prompt is sitting in Postgres,
 * intact, at an address nobody asked.
 *
 * The mint writes this record and nothing else does, so there is no UI for it:
 * this is a one-off repair, not a feature. New mints are already correct.
 *
 *   CAPSULE_OWNER_KEY=0x… npm run fix:endpoint trader.testpriv.eth dev.testpriv.eth
 *
 * The key must be the name's OWNER. `PermissionedResolver` checks the caller
 * against `nameResourceOf(node)` — the name itself — so the agent's own key
 * cannot do this, by design. It holds one grant, on `agent-heartbeat`.
 *
 * Idempotent: a name already carrying the right value is skipped, not rewritten,
 * so re-running after a partial failure costs nothing.
 */
import { createWalletClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { namehash } from "viem/ens";
import { CHAIN, createServerClient } from "../lib/capsule/chain";
import { InvalidEnvError, MissingEnvError, loadServerEnv } from "../lib/capsule/env";
import { RECORD_KEYS } from "../lib/capsule/records";
import { readText } from "../lib/capsule/resolve";

/* Local rather than added to `resolverAdminAbi`: that ABI is the shared surface
   the app writes through, and this script is a migration that should not widen
   it. `setText` is the resolver's own, unchanged since ENSIP-5. */
const resolverTextAbi = parseAbi([
  "function setText(bytes32 node, string key, string value)",
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
]);

const reason = (error: unknown) =>
  error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);

async function main() {
  const names = process.argv.slice(2).map((n) => n.trim().toLowerCase()).filter((n) => n !== "");
  if (names.length === 0) {
    console.error("\n  usage: npm run fix:endpoint <name> [name…]\n");
    process.exit(1);
  }

  let env;
  try {
    env = loadServerEnv();
  } catch (error) {
    if (error instanceof MissingEnvError || error instanceof InvalidEnvError) {
      console.error(`\n  env  ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const rawKey = process.env.CAPSULE_OWNER_KEY;
  if (rawKey === undefined || rawKey === "") {
    console.error("\n  CAPSULE_OWNER_KEY is not set — it must be the key that owns these names.\n");
    process.exit(1);
  }
  const account = privateKeyToAccount(
    (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex,
  );

  // The value the fixed prepare route now writes, built from the same env var,
  // so this script and the route cannot disagree about what "correct" is.
  const target = `${env.publicUrl}/api`;

  const publicClient = createServerClient(env.rpcUrl);
  const wallet = createWalletClient({ account, chain: CHAIN, transport: http(env.rpcUrl) });

  console.log(`\n  owner     ${account.address}`);
  console.log(`  target    ${target}\n`);

  let failed = 0;

  for (const name of names) {
    const node = namehash(name);

    let current: string;
    let resolver: Address;
    try {
      const read = await readText(publicClient, name, RECORD_KEYS.endpointCapsule);
      current = read.value;
      resolver = read.resolver;
    } catch (error) {
      console.log(`  ❌ ${name}\n     could not read the record — ${reason(error)}`);
      failed += 1;
      continue;
    }

    if (current === target) {
      console.log(`  ✅ ${name}\n     already correct, left alone`);
      continue;
    }

    // Simulated before it is sent: a revert here is the resolver saying this key
    // may not write this name, and that is worth reading as a sentence rather
    // than as a failed transaction hash.
    try {
      await publicClient.simulateContract({
        address: resolver,
        abi: resolverTextAbi,
        functionName: "setText",
        args: [node, RECORD_KEYS.endpointCapsule, target],
        account,
      });
    } catch (error) {
      console.log(`  ❌ ${name}\n     the resolver refused this caller — ${reason(error)}`);
      failed += 1;
      continue;
    }

    try {
      const hash = await wallet.writeContract({
        address: resolver,
        abi: resolverTextAbi,
        functionName: "setText",
        args: [node, RECORD_KEYS.endpointCapsule, target],
      });
      // Waited on, not fired and forgotten. The record is the agent's whole
      // configuration; "probably written" is not a state worth reporting.
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        console.log(`  ❌ ${name}\n     reverted on chain — ${hash}`);
        failed += 1;
        continue;
      }
      console.log(`  ✅ ${name}\n     ${current || "(unset)"} → ${target}\n     ${hash}`);
    } catch (error) {
      console.log(`  ❌ ${name}\n     ${reason(error)}`);
      failed += 1;
    }
  }

  console.log(
    failed === 0
      ? "\n  done — restart the machines and they will boot on the new endpoint.\n"
      : `\n  ${failed} name(s) failed.\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
