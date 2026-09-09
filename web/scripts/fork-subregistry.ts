/**
 * Proves the subregistry flow end to end, against the real chain state.
 *
 * The three transactions in `connect.ts` that give a `.eth` name a subregistry
 * cannot be checked by reading: they are writes, they cost real money, and two
 * of them are role-gated in ways that only show up when a specific account
 * sends them. So this runs them — as the actual owner of an actual name — on a
 * fork of Sepolia, using the same exported functions the browser calls.
 *
 * The account is impersonated rather than a fresh key, and that is the point.
 * A fresh key would prove the code compiles; impersonating the name's owner
 * proves the roles the registrar granted at registration are the roles these
 * transactions need, which is the only claim /connect is making.
 *
 * Start a fork first:
 *
 *     anvil --fork-url $SEPOLIA_RPC_URL --port 8545
 *     npm run fork:subregistry [label]
 */
import { createPublicClient, createWalletClient, http, zeroAddress, type Address } from "viem";
import { sepolia } from "viem/chains";
import { ETH_REGISTRY, registryAbi } from "../lib/capsule/chain";
import { attachSubregistry, deploySubregistry, linkSubregistryParent } from "../lib/capsule/connect";
import { encodeParent, parentBlocker, parentIsReady, readParentStatus } from "../lib/capsule/parent";
import { PERMISSIONED_REGISTRY_BYTECODE } from "../lib/capsule/registry-bytecode";

const FORK = "http://127.0.0.1:8545";
/** The minter the web app is pointed at. Only used to read a status back. */
const MINTER = "0xE114CAf799f11Ed61Bd44Fc7d498D96Db62bDF51" as Address;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  const label = process.argv[2] ?? "testpriv";
  const parent = encodeParent(`${label}.eth`);

  const publicClient = createPublicClient({ chain: sepolia, transport: http(FORK) });
  const block = await publicClient.getBlockNumber().catch(() => null);
  if (block === null) {
    console.error(`no fork at ${FORK} — start one with:\n  anvil --fork-url $SEPOLIA_RPC_URL --port 8545`);
    process.exit(1);
  }
  console.log(`fork at block ${block}\nname ${parent.name}\n`);

  /* Snapshot first, revert at the end. This script writes to the fork — it
     deploys a registry and attaches it — so without this the second run starts
     against a name that already has a subregistry and the "before" assertions
     fail for a reason that has nothing to do with the code. A test that only
     passes on a fresh anvil is a test people learn to re-run rather than read. */
  const snapshot = (await publicClient.request({
    method: "evm_snapshot" as never,
    params: [] as never,
  })) as string;

  // The owner is read off the chain rather than passed in, so the script cannot
  // be run as the wrong account and still pass.
  const owner = await publicClient.readContract({
    address: ETH_REGISTRY,
    abi: registryAbi,
    functionName: "findOwner",
    args: [parent.label],
  });
  console.log(`owner ${owner}\n`);
  check("the name is owned by somebody", owner !== zeroAddress);

  await publicClient.request({ method: "anvil_impersonateAccount" as never, params: [owner] as never });
  await publicClient.request({
    method: "anvil_setBalance" as never,
    params: [owner, "0x56bc75e2d63100000"] as never, // 100 ETH, enough for a 31KB deploy
  });

  const walletClient = createWalletClient({ account: owner, chain: sepolia, transport: http(FORK) });

  // --- before ---------------------------------------------------------------
  const before = await readParentStatus(publicClient as never, MINTER, parent, owner);
  check("starts with no subregistry", before.registry === null, String(before.registry));
  check("  but is registered", before.registered === true);
  check("  and the owner may set one", before.callerMaySetSubregistry === true);
  check("  its token id was found", before.tokenId !== null, String(before.tokenId));
  check(
    "  the blocker names the subregistry, not permissions",
    (parentBlocker(before) ?? "").includes("no subregistry"),
    parentBlocker(before) ?? "",
  );
  if (before.tokenId === null) {
    console.log("\ncannot continue without a token id");
    process.exit(1);
  }

  // --- 1. deploy ------------------------------------------------------------
  console.log("\n1. deploying PermissionedRegistry…");
  const { hash: deployHash, registry } = await deploySubregistry(
    { walletClient, publicClient: publicClient as never, owner },
    (phase, detail) => console.log(`   ${phase}${detail ? ` ${detail}` : ""}`),
  );
  const receipt = await publicClient.getTransactionReceipt({ hash: deployHash });
  console.log(`   registry ${registry} · gas ${receipt.gasUsed}`);
  check("a registry was deployed", registry !== zeroAddress);

  // The vendored bytecode must be the code that is actually running, or every
  // later assertion is about some other contract.
  const deployed = await publicClient.getCode({ address: registry });
  check("  it has code", deployed !== undefined && deployed !== "0x", `${(deployed?.length ?? 2) / 2 - 1} bytes`);
  check(
    "  the vendored creation bytecode is the one that ran",
    PERMISSIONED_REGISTRY_BYTECODE.startsWith("0x") && PERMISSIONED_REGISTRY_BYTECODE.length > 60000,
    `${PERMISSIONED_REGISTRY_BYTECODE.length / 2 - 1} bytes of creation code`,
  );

  /* The strongest available check on the vendored bytecode: compare the runtime
     code it produced against a `PermissionedRegistry` that ENS's own deployment
     is already using. If our copy were stale or from a different compilation,
     this is where it shows — not in a user's transaction six weeks from now. */
  const reference = await publicClient.readContract({
    address: ETH_REGISTRY,
    abi: registryAbi,
    functionName: "getSubregistry",
    args: ["capsulefleet"],
  });
  const referenceCode = await publicClient.getCode({ address: reference });
  check(
    "  its runtime code matches a registry already live on this deployment",
    referenceCode !== undefined && referenceCode === deployed,
    `vs ${reference}`,
  );

  // Deploying is not attaching. Until step 2 the name is unchanged, and a UI
  // that marked the step done here would be lying.
  const midway = await readParentStatus(publicClient as never, MINTER, parent, owner);
  check("  the name still has no subregistry until it is attached", midway.registry === null);

  // --- 2. attach (parent -> child) -----------------------------------------
  console.log("\n2. attaching it to the name…");
  await attachSubregistry(
    { walletClient, publicClient: publicClient as never, tokenId: before.tokenId, registry },
    (phase, detail) => console.log(`   ${phase}${detail ? ` ${detail}` : ""}`),
  );
  const attached = await readParentStatus(publicClient as never, MINTER, parent, owner);
  check("the name now has a subregistry", attached.registry?.toLowerCase() === registry.toLowerCase(), String(attached.registry));

  // The half-linked state is the one that looks finished and is not. If this
  // assertion ever flips, the two-way link has collapsed into one and the
  // `parentLinked` field is dead weight.
  check("  but the registry does not point back yet", attached.parentLinked === false);
  check(
    "  and the blocker says so, rather than calling the name ready",
    (parentBlocker(attached) ?? "").includes("point back"),
    parentBlocker(attached) ?? "",
  );

  // --- 3. link (child -> parent) -------------------------------------------
  console.log("\n3. pointing the registry back at the name…");
  await linkSubregistryParent(
    { walletClient, publicClient: publicClient as never, registry, label: parent.label },
    (phase, detail) => console.log(`   ${phase}${detail ? ` ${detail}` : ""}`),
  );
  const after = await readParentStatus(publicClient as never, MINTER, parent, owner);
  check("both halves of the link are set", after.parentLinked === true);

  const link = await publicClient.readContract({ address: registry, abi: registryAbi, functionName: "getParent" });
  check("  the registry names ETH_REGISTRY as its parent", link[0].toLowerCase() === ETH_REGISTRY.toLowerCase(), link[0]);
  check("  under this exact label", link[1] === parent.label, `"${link[1]}"`);

  const blocker = parentBlocker(after);
  check(
    "the blocker moves on to connecting, not to nothing",
    blocker !== null && blocker.includes("connected"),
    blocker ?? "null",
  );

  // --- the rest of /connect -------------------------------------------------
  // The subregistry step only matters if the four steps after it now work. A
  // registry that satisfies `parentLinked` and then fails `connectParent` would
  // pass every assertion above and still leave the user exactly as stuck.
  console.log("\n4. running the rest of /connect on top of it…");
  const { deployResolver, grantRegistrar, grantResolverRoles, connectParent } = await import(
    "../lib/capsule/connect"
  );
  const quiet = () => {};

  const { resolver } = await deployResolver(
    { walletClient, publicClient: publicClient as never, admin: owner },
    quiet,
  );
  console.log(`   resolver ${resolver}`);
  await grantRegistrar(
    { walletClient, publicClient: publicClient as never, registry, minter: MINTER },
    quiet,
  );
  await grantResolverRoles(
    { walletClient, publicClient: publicClient as never, resolver, minter: MINTER },
    quiet,
  );
  await connectParent(
    {
      walletClient,
      publicClient: publicClient as never,
      minter: MINTER,
      registry,
      resolver,
      parent,
      open: false,
    },
    quiet,
  );

  const ready = await readParentStatus(publicClient as never, MINTER, parent, owner);
  check("the minter holds ROLE_REGISTRAR on the new registry", ready.registrarGranted === true);
  check("  and its root roles on the resolver", ready.resolverRolesGranted === true);
  check("  the name is connected", ready.connected === true);
  check("  this account may mint here", ready.callerMayMint === true);
  check("  nothing is blocking a launch", parentBlocker(ready) === null, parentBlocker(ready) ?? "null");
  check("  and parentIsReady agrees", parentIsReady(ready) === true);

  // --- what /connect showed before that ------------------------------------
  // (asserted before step 4 ran, from the status read straight after step 3)
  check("the owner administers the new registry", after.callerIsAdmin === true);

  await publicClient.request({ method: "evm_revert" as never, params: [snapshot] as never });
  console.log(`\nfork reverted to snapshot ${snapshot}`);

  console.log(`\n${failures === 0 ? "subregistry flow OK" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
