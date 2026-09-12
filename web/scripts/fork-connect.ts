/**
 * Proves the one-button connect, against real chain state.
 *
 * `fork-connect` is to `runConnect` what `fork-subregistry` is to the three
 * subregistry transactions: it runs the real exported function, as the real owner
 * of a real name, on a fork of Sepolia. The claims it checks are the two that
 * cannot be checked by reading:
 *
 *   1. The grants folded into `initialize` actually land. `ROLE_REGISTRAR` on the
 *      registry and `REQUIRED_RESOLVER_ROOT_ROLES` on the resolver are supposed to
 *      be true the moment each proxy exists, with no `grantRootRoles` sent after.
 *      If the hackathon deployment's `initialize` granted at some resource other
 *      than root, every read would still succeed and the first mint would revert.
 *
 *   2. `predictProxyAddress` predicts the address the factory actually uses. That
 *      is what the EIP-5792 batch is built on — call 2 references the contract
 *      call 1 deploys — so a wrong prediction is a batch that reverts in a
 *      wallet, which is the worst place to discover it.
 *
 * It also counts the signatures, which is the thing this change is for.
 *
 * Start a fork first:
 *
 *     anvil --fork-url $SEPOLIA_RPC_URL --port 8545
 *     npm run fork:connect [label]
 *
 * With no label it finds one: a name registered on this deployment that has no
 * subregistry yet, which is the state every /connect visitor arrives in.
 */
import { createPublicClient, createWalletClient, http, parseAbi, zeroAddress, type Address } from "viem";
import { normalize } from "viem/ens";
import { sepolia } from "viem/chains";
import { DEPLOYMENTS, ROLE_REGISTRAR, registryAbi } from "../lib/capsule/chain";
import {
  REGISTRY_SALT,
  RESOLVER_SALT,
  minterHasResolverRoles,
  planConnect,
  predictProxyAddress,
  readProxyLogic,
  runConnect,
} from "../lib/capsule/connect";
import { encodeParent, parentBlocker, parentIsReady, readParentStatus } from "../lib/capsule/parent";

/* The deployment the app defaults to, and the only one whose `initialize` takes a
   list of grants. The beta keeps the explicit-grant path, which
   `fork-subregistry` already covers. */
const DEPLOYMENT = DEPLOYMENTS.hackathon;
const FORK = "http://127.0.0.1:8545";
const MINTER = (process.env.CAPSULE_MINTER_ADDRESS ?? "0xE114CAf799f11Ed61Bd44Fc7d498D96Db62bDF51") as Address;

const registrationAbi = parseAbi([
  "event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelId, string label, address owner, uint64 expiry, address by)",
]);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  const publicClient = createPublicClient({ chain: sepolia, transport: http(FORK) });
  const block = await publicClient.getBlockNumber().catch(() => null);
  if (block === null) {
    console.error(`no fork at ${FORK} — start one with:\n  anvil --fork-url $SEPOLIA_RPC_URL --port 8545`);
    process.exit(1);
  }
  console.log(`fork at block ${block}\nminter ${MINTER}\n`);

  /* ---- pick a name in the state a /connect visitor arrives in ---- */
  let label = process.argv[2] ?? null;
  if (label === null) {
    const logs = await publicClient.getContractEvents({
      address: DEPLOYMENT.ethRegistry,
      abi: registrationAbi,
      eventName: "LabelRegistered",
      fromBlock: block - 45_000n,
      toBlock: "latest",
    });
    for (const log of logs.reverse()) {
      const candidate = log.args.label;
      if (candidate === undefined || candidate === "") continue;
      /* Skip labels that are not already in normalised form. ENS lets you register
         `Aegis` and `encodeParent` would resolve `aegis`, which is a different
         label and not registered — a real asymmetry, but not this test's subject. */
      let normalised: string;
      try {
        normalised = normalize(candidate);
      } catch {
        continue;
      }
      if (normalised !== candidate) continue;
      const subregistry = await publicClient.readContract({
        address: DEPLOYMENT.ethRegistry,
        abi: registryAbi,
        functionName: "getSubregistry",
        args: [candidate],
      });
      if (subregistry === zeroAddress) {
        label = candidate;
        break;
      }
    }
    if (label === null) {
      console.error("found no registered name without a subregistry in the last 45k blocks — pass a label");
      process.exit(1);
    }
    console.log(`picked ${label}.eth (registered, no subregistry)\n`);
  }
  const parent = encodeParent(`${label}.eth`);

  const snapshot = (await publicClient.request({
    method: "evm_snapshot" as never,
    params: [] as never,
  })) as string;

  const owner = await publicClient.readContract({
    address: DEPLOYMENT.ethRegistry,
    abi: registryAbi,
    functionName: "findOwner",
    args: [parent.label],
  });
  check("the name is owned by somebody", owner !== zeroAddress, owner);
  await publicClient.request({ method: "anvil_impersonateAccount" as never, params: [owner] as never });
  await publicClient.request({
    method: "anvil_setBalance" as never,
    params: [owner, "0x56bc75e2d63100000"] as never,
  });
  const walletClient = createWalletClient({ account: owner, chain: sepolia, transport: http(FORK) });

  const before = await readParentStatus(publicClient as never, MINTER, parent, owner);
  check("starts with no subregistry", before.registry === null);
  check("  is registered", before.registered === true);
  check("  and this wallet may give it one", before.callerMaySetSubregistry === true);
  check("  so something is blocking it", parentBlocker(before) !== null, parentBlocker(before) ?? "");
  if (!before.registered || owner === zeroAddress) {
    console.error(`\n${parent.name} is not registered on this deployment — pass a label that is`);
    await publicClient.request({ method: "evm_revert" as never, params: [snapshot] as never });
    process.exit(1);
  }

  /* ---- what the batch would be ---- */
  const plan = await planConnect({
    publicClient: publicClient as never,
    status: before,
    owner,
    minter: MINTER,
    open: false,
  });
  console.log(`\nplan: ${plan.calls.length} calls`);
  plan.calls.forEach((call, i) => console.log(`  ${i + 1}. ${call.label} -> ${call.to}`));
  check("the plan is batchable on this deployment", plan.batchable === true);
  check(
    "  and it is five calls, not seven",
    plan.calls.length === 5,
    `${plan.calls.length}: ${plan.calls.map((c) => c.label).join(", ")}`,
  );
  check(
    "  no grantRootRoles call survives in it",
    plan.calls.every((call) => !call.label.includes("Letting Capsule")),
  );

  /* The prediction the batch depends on, checked against the factory's own
     derivation before anything is signed. */
  const proxyLogic = await readProxyLogic(publicClient as never, DEPLOYMENT);
  const predictedRegistry = predictProxyAddress({
    factory: DEPLOYMENT.verifiableFactory,
    proxyLogic,
    deployer: owner,
    salt: REGISTRY_SALT,
  });
  const predictedResolver = predictProxyAddress({
    factory: DEPLOYMENT.verifiableFactory,
    proxyLogic,
    deployer: owner,
    salt: RESOLVER_SALT,
  });
  check("the plan names the predicted registry", plan.registry === predictedRegistry, String(plan.registry));
  check("  and the predicted resolver", plan.resolver === predictedResolver, String(plan.resolver));
  check("  which are different addresses", predictedRegistry !== predictedResolver);

  /* ---- run it ---- */
  console.log("\nrunning runConnect (sequential path — anvil is not a 5792 wallet)…");
  let signatures = 0;
  const status = await runConnect(
    {
      walletClient,
      publicClient: publicClient as never,
      account: owner,
      minter: MINTER,
      parent,
      open: false,
    },
    (event) => {
      if (event.phase === "signing") signatures += 1;
      if (event.done !== undefined) console.log(`   ✓ ${event.done}`);
    },
  );

  console.log(`\n${signatures} signature(s)`);
  check("it took five signatures, not seven", signatures === 5, String(signatures));

  /* ---- the claim that matters: the grants landed without being granted ---- */
  const registry = status.registry;
  check("the name has a subregistry", registry !== null, String(registry));
  check("  at the predicted address", registry === predictedRegistry, String(registry));
  check("  both halves of the link are set", status.parentLinked === true);
  if (registry !== null) {
    const granted = await publicClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "hasRoles",
      args: [0n, ROLE_REGISTRAR, MINTER],
    });
    check("  the minter holds ROLE_REGISTRAR at the registry's ROOT resource", granted === true);
  }
  check("the minter holds its root roles on the resolver", status.resolverRolesGranted === true);
  check(
    "  and the resolver itself agrees",
    await minterHasResolverRoles(publicClient as never, MINTER, predictedResolver),
  );
  check("the name is connected", status.connected === true);
  check("this wallet may mint here", status.callerMayMint === true);
  check("nothing is blocking a launch", parentBlocker(status) === null, parentBlocker(status) ?? "null");
  check("  and parentIsReady agrees", parentIsReady(status) === true);

  /* ---- idempotence: the button must be safe to press twice ---- */
  console.log("\nrunning it again on a connected name…");
  let extra = 0;
  await runConnect(
    {
      walletClient,
      publicClient: publicClient as never,
      account: owner,
      minter: MINTER,
      parent,
      open: false,
    },
    (event) => {
      if (event.phase === "signing") extra += 1;
    },
  );
  check("a second run signs nothing", extra === 0, String(extra));

  /* ---- resumability: a run interrupted after the deploy must not redeploy ----

     The state that used to need a paste field. `runConnect` is given no
     `knownRegistry`, so finding the registry it already deployed is entirely down
     to `findExistingProxy` looking at the predicted address. */
  await publicClient.request({ method: "evm_revert" as never, params: [snapshot] as never });
  const snapshot2 = (await publicClient.request({
    method: "evm_snapshot" as never,
    params: [] as never,
  })) as string;
  console.log("\nreverted; now interrupting after the first deployment…");
  await publicClient.request({ method: "anvil_impersonateAccount" as never, params: [owner] as never });
  await publicClient.request({
    method: "anvil_setBalance" as never,
    params: [owner, "0x56bc75e2d63100000"] as never,
  });
  const { deploySubregistry } = await import("../lib/capsule/connect");
  const deployed = await deploySubregistry(
    { walletClient, publicClient: publicClient as never, owner, deployment: DEPLOYMENT, minter: MINTER },
    () => {},
  );
  check("the orphan registry landed where it was predicted", deployed.registry === predictedRegistry, deployed.registry);
  check("  and reports that it granted the minter", deployed.grantsMinter === true);

  let resumed = 0;
  const after = await runConnect(
    {
      walletClient,
      publicClient: publicClient as never,
      account: owner,
      minter: MINTER,
      parent,
      open: false,
    },
    (event) => {
      if (event.phase === "signing") resumed += 1;
    },
  );
  check("the resumed run finishes the name", after.callerMayMint === true);
  check("  in four signatures, reusing the registry it found", resumed === 4, String(resumed));
  check("  and it is the same registry", after.registry === predictedRegistry, String(after.registry));

  /* ---- the batch payload itself ----

     `runConnect`'s sequential path calls the typed functions, so everything above
     proves the steps and nothing about `plan.calls`. A 5792 wallet executes that
     calldata in order, which is exactly what this does — one transaction per call,
     no simulation, the encoded bytes as the plan built them. What it cannot
     reproduce is the single confirmation and the atomicity, which are the wallet's
     side of the contract; what it does reproduce is every way the payload could be
     wrong: a bad selector, arguments in the wrong order, a call addressed to a
     contract that the previous call was supposed to have deployed. */
  await publicClient.request({ method: "evm_revert" as never, params: [snapshot2] as never });
  const snapshot3 = (await publicClient.request({
    method: "evm_snapshot" as never,
    params: [] as never,
  })) as string;
  console.log("\nreverted; now executing the batch payload call by call…");
  await publicClient.request({ method: "anvil_impersonateAccount" as never, params: [owner] as never });
  await publicClient.request({
    method: "anvil_setBalance" as never,
    params: [owner, "0x56bc75e2d63100000"] as never,
  });
  const fresh = await readParentStatus(publicClient as never, MINTER, parent, owner);
  const batch = await planConnect({
    publicClient: publicClient as never,
    status: fresh,
    owner,
    minter: MINTER,
    open: false,
  });
  for (const [index, call] of batch.calls.entries()) {
    const hash = await walletClient.sendTransaction({ to: call.to, data: call.data } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    check(`  call ${index + 1}/${batch.calls.length} — ${call.label}`, receipt.status === "success", receipt.status);
  }
  const batched = await readParentStatus(publicClient as never, MINTER, parent, owner);
  check("the batch payload leaves the name ready", batched.callerMayMint === true);
  check("  at the registry the plan predicted", batched.registry === batch.registry, String(batched.registry));
  check("  with the resolver it predicted", batched.resolver === batch.resolver, String(batched.resolver));
  check("  and nothing blocking a launch", parentBlocker(batched) === null, parentBlocker(batched) ?? "null");

  await publicClient.request({ method: "evm_revert" as never, params: [snapshot3] as never });
  console.log(`\n${failures === 0 ? "one-button connect OK" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
