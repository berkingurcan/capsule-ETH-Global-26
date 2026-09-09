/**
 * Proves the recall against the live resolver, without pulling anything.
 *
 * `eth_call` runs the real `authorizeTextRoles()` against real state, from the
 * real owner's address, and reverts for the real reasons — so the entire kill
 * switch can be checked here, on live capsules, with no transaction and no
 * funded account. Nothing this script does is visible on chain.
 *
 * What it catches that a passing build does not:
 *
 *   1. **The DNS wire name.** `authorizeTextRoles` takes `toName`, not a node,
 *      and namehashes it itself. A namehash in that slot is a valid `bytes`
 *      argument that revokes a role on a name nobody owns — it does not fail to
 *      compile, encode, or (with the right caller) execute. Asserted byte for
 *      byte against `CapsuleMinter.dnsNameOf`.
 *   2. **`nameResourceOf`.** The resolver checks the *caller* against
 *      `ROLE_SET_TEXT_ADMIN` on `resource(node, 0)`, which is a different
 *      resource from the key-level one every read path uses. Get it wrong and
 *      the dialog tells the owner they may not recall their own agent — while
 *      the transaction would have worked. Checked against a real simulation, so
 *      a wrong derivation shows up as a contradiction rather than a guess.
 *   3. **`nothing-to-do`.** `_revokeRoles` returns false instead of reverting
 *      when there is no role to pull. A recalled capsule must simulate to
 *      `false`, or the UI would happily charge for a no-op.
 *   4. **The reverts the UI names.** A stranger's recall must come back as
 *      `EACCannotRevokeRoles` and decode against `resolverAdminAbi`; if it does
 *      not, the user is shown a bare selector.
 *   5. **`rolesChangedFrom`.** `recallCapsule` refuses to report a recall it
 *      cannot read the event for, so a wrong event signature would turn every
 *      successful revoke into an error. Checked against a real historic log.
 *
 * Run with:  npm run check:recall
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
  type Address,
} from "viem";
import { sepolia } from "viem/chains";
import {
  ROLE_SET_TEXT,
  ROLE_SET_TEXT_ADMIN,
  minterAbi,
  nameResourceOf,
  resolverAdminAbi,
  textResourceOf,
} from "../lib/capsule/chain";
import { RECORD_KEYS } from "../lib/capsule/records";
import { readFleet } from "../lib/capsule/fleet";
import { buildRecallArgs, recallPreflight, rolesChangedFrom, type RecallTarget } from "../lib/capsule/recall";
import { loadServerEnv } from "../lib/capsule/env";

/** Holds no roles anywhere. Stands in for "someone else's wallet". */
const STRANGER = "0x000000000000000000000000000000000000dEaD" as Address;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** The error name a simulated call reverted with, or null if it did not revert. */
function revertNameOf(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return "«undecoded»";
  return reverted.data?.errorName ?? "«unnamed»";
}

async function main() {
  const env = loadServerEnv();
  const client = createPublicClient({ chain: sepolia, transport: http(env.rpcUrl, { batch: true }) });

  console.log(`minter ${env.minterAddress} on ${sepolia.name}\n`);

  const fleet = await readFleet(client as never, {
    minter: env.minterAddress,
    parentName: env.parentName,
    fromBlock: env.minterBlock,
  });
  check("fleet is not empty", fleet.capsules.length > 0, `${fleet.capsules.length} minted`);

  // --- the reverts the dialog renders as sentences --------------------------
  const named = new Set(
    resolverAdminAbi.filter((item) => item.type === "error").map((item) => (item as { name: string }).name),
  );
  for (const name of [
    "EACCannotRevokeRoles",
    "EACUnauthorizedAccountRoles",
    "DNSDecodingFailed",
    "EACInvalidAccount",
    "EACInvalidRoleBitmap",
    "EACMinAssignees",
  ]) {
    check(`resolverAdminAbi declares ${name}`, named.has(name));
  }

  for (const capsule of fleet.capsules) {
    console.log(`\n${capsule.name}  (${capsule.status})`);

    const target: RecallTarget = {
      name: capsule.name,
      node: capsule.node,
      resolver: capsule.resolver,
      agent: capsule.agent,
    };
    const [dnsName, key, account, grant] = buildRecallArgs(target);

    // --- 1. the name, byte for byte -----------------------------------------
    const onChainDns = await client.readContract({
      address: env.minterAddress,
      abi: minterAbi,
      functionName: "dnsNameOf",
      args: [capsule.label],
    });
    check("  dnsName matches CapsuleMinter.dnsNameOf", dnsName === onChainDns, `${dnsName}`);
    check("  the key is the heartbeat key", key === RECORD_KEYS.heartbeat, key);
    check("  the account is the agent from the mint event", account === capsule.agent, account);
    check("  grant is false", grant === false);

    // --- 2. the two resources are not the same one --------------------------
    const nameResource = nameResourceOf(capsule.node);
    const textResource = textResourceOf(capsule.node, RECORD_KEYS.heartbeat);
    check("  the name resource differs from the key resource", nameResource !== textResource);

    const [ownerMayRevoke, strangerMayRevoke] = await Promise.all([
      client.readContract({
        address: capsule.resolver,
        abi: resolverAdminAbi,
        functionName: "hasRoles",
        args: [nameResource, ROLE_SET_TEXT_ADMIN, capsule.owner],
      }),
      client.readContract({
        address: capsule.resolver,
        abi: resolverAdminAbi,
        functionName: "hasRoles",
        args: [nameResource, ROLE_SET_TEXT_ADMIN, STRANGER],
      }),
    ]);
    check("  the owner holds ROLE_SET_TEXT_ADMIN on the name", ownerMayRevoke, capsule.owner);
    check("  a stranger does not", !strangerMayRevoke);

    // The preflight the dialog runs must give the same two answers.
    const pre = await recallPreflight(client as never, target, capsule.owner);
    check("  preflight.maySend agrees", pre.maySend === ownerMayRevoke);
    check(
      "  preflight.agentAuthorized agrees with the fleet",
      pre.agentAuthorized === capsule.authorized,
      `${pre.agentAuthorized} vs ${capsule.authorized}`,
    );

    // --- 3. the real call, simulated from the real owner ---------------------
    //
    // `true` means it would clear the role; `false` means there is nothing to
    // clear. Either is a correct answer — which one is correct is decided by
    // whether the agent is still authorized, and that is the assertion.
    try {
      const { result } = await client.simulateContract({
        address: capsule.resolver,
        abi: resolverAdminAbi,
        functionName: "authorizeTextRoles",
        args: buildRecallArgs(target),
        account: capsule.owner,
      });
      check(
        "  the owner's recall simulates",
        result === capsule.authorized,
        result ? "would revoke the role" : "nothing to revoke (already recalled)",
      );
    } catch (error) {
      check("  the owner's recall simulates", false, `reverted with ${revertNameOf(error)}`);
    }

    // --- 4. and a stranger's does not ---------------------------------------
    try {
      await client.simulateContract({
        address: capsule.resolver,
        abi: resolverAdminAbi,
        functionName: "authorizeTextRoles",
        args: buildRecallArgs(target),
        account: STRANGER,
      });
      check("  a stranger's recall reverts", false, "it did not");
    } catch (error) {
      const got = revertNameOf(error);
      check("  a stranger's recall reverts with a named error", got === "EACCannotRevokeRoles", `${got}`);
    }
  }

  // --- 5. the event the receipt is read through -----------------------------
  //
  // The fleet has a known revoke/regrant pair in its history, so an empty
  // result here means the signature is wrong, not that nothing ever happened.
  const capsule = fleet.capsules[0];
  if (capsule !== undefined) {
    const resources = fleet.capsules.map((c) => textResourceOf(c.node, RECORD_KEYS.heartbeat));
    const logs = await client.getContractEvents({
      address: capsule.resolver,
      abi: resolverAdminAbi,
      eventName: "EACRolesChanged",
      args: { resource: resources },
      fromBlock: env.minterBlock,
      toBlock: "latest",
    });
    check("\nEACRolesChanged logs were found", logs.length > 0, `${logs.length} on heartbeat keys`);

    const first = logs[0];
    if (first !== undefined) {
      const resource = first.args.resource!;
      const holder = first.args.account!;
      const parsed = rolesChangedFrom([first] as never, capsule.resolver, resource, holder);
      check("rolesChangedFrom decodes a real log", parsed !== null);
      check(
        "  a log for another account is ignored",
        rolesChangedFrom([first] as never, capsule.resolver, resource, STRANGER) === null,
      );
      check(
        "  a log for another resource is ignored",
        rolesChangedFrom([first] as never, capsule.resolver, resource + 1n, holder) === null,
      );
      check(
        "  a log from another contract is ignored",
        rolesChangedFrom([first] as never, STRANGER, resource, holder) === null,
      );
    }

    // Every revoke in that history must have cleared exactly the bit the recall
    // targets. If ROLE_SET_TEXT here were the wrong bit, the fleet would still
    // render — it would just never call anything recalled.
    const revokes = logs.filter(
      (log) => (log.args.oldRoleBitmap! & ROLE_SET_TEXT) !== 0n && (log.args.newRoleBitmap! & ROLE_SET_TEXT) === 0n,
    );
    check(
      "ROLE_SET_TEXT is the bit that moves on a revoke",
      logs.length === 0 || revokes.length > 0,
      `${revokes.length} of ${logs.length} logs cleared it`,
    );
  }

  console.log(`\n${failures === 0 ? "recall path OK — nothing was sent" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
