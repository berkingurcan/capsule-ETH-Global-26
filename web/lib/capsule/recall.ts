/**
 * The recall, as one call the browser can make.
 *
 * Client-safe: no env, no node:crypto, no server RPC. Everything it needs is
 * on the `Capsule` the dashboard already read off the chain — the resolver the
 * name actually points at, the node, and the agent address out of the mint
 * event — so nothing here is configured and nothing is guessed.
 *
 * ## What it sends, and why that is the whole product
 *
 *     resolver.authorizeTextRoles(dnsName, "agent-heartbeat", agent, false)
 *
 * One call, to ENS, from the owner's own wallet. Not to CapsuleMinter — the
 * minter has no `halt()` and never will, because a kill switch that depends on
 * our contract existing is a kill switch we could take away. `mint()` grants
 * the owner `ROLE_SET_TEXT_ADMIN` on their own name, and this is that role
 * being used. If every line of Capsule disappeared tomorrow, an owner with
 * Etherscan could still send exactly this.
 *
 * Nothing else is torn down: the subname stays registered, every record stays
 * readable, the sealed prompt and credentials stay in the store. The agent's
 * next `setText` reverts with `EACUnauthorizedAccountRoles`, and the runner
 * exits on that revert. Re-granting the role revives it.
 *
 * ## Why this simulates first
 *
 * Same reason as the mint, plus one that is specific to a revoke. `eth_call`
 * answers two questions for free that a sent transaction answers expensively:
 *
 *   1. **May this wallet do it?** The resolver checks the caller against
 *      `ROLE_SET_TEXT_ADMIN` on the *name-level* resource. A wallet that is not
 *      the owner — a second address in the same wallet, an owner who has since
 *      transferred the name — reverts with `EACCannotRevokeRoles`.
 *   2. **Would it change anything?** `_revokeRoles` returns `false` rather than
 *      reverting when the account does not hold the role. A capsule recalled
 *      from another tab five seconds ago produces a perfectly successful
 *      transaction that does nothing, emits nothing, and costs 24k gas. That
 *      is reported here as `nothing-to-do` before the wallet ever opens.
 *
 * ## Why the result is read from the receipt, then from the chain
 *
 * `EACRolesChanged` is the only proof the role moved. A mined transaction to
 * the right address that emitted no such log is not a recall, and is reported
 * as a failure even on a successful receipt — the same rule `mintCapsule`
 * applies to `CapsuleMinted`, for the same reason: this dashboard's one claim
 * is that it never invents a status. After the event decodes, `hasRoles` is
 * read back at the mined block. That final read is what the UI is allowed to
 * call "recalled".
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  ROLE_SET_TEXT,
  ROLE_SET_TEXT_ADMIN,
  nameResourceOf,
  resolverAdminAbi,
  textResourceOf,
} from "./chain";
import { RECORD_KEYS } from "./records";
import { encodeName } from "./resolve";

/**
 * Everything the call needs, and nothing that could be stale.
 *
 * `resolver` is the address the name currently resolves through, not a
 * configured one: the registry can be repointed, and the roles live on
 * whichever resolver it points at now.
 */
export type RecallTarget = {
  /** The full name, e.g. `trader.capsulefleet.eth`. */
  name: string;
  node: Hex;
  resolver: Address;
  /** The agent whose write permission is being pulled. */
  agent: Address;
};

export type RecallReceipt = {
  hash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  /** The key-level resource the role was cleared on. */
  resource: bigint;
  /** Straight from `EACRolesChanged` — what the agent held, and holds now. */
  oldRoles: bigint;
  newRoles: bigint;
};

/**
 * A failure with something the user can act on.
 *
 * `nothing-to-do` is not an error in the usual sense and the UI does not draw
 * it in red: it means the chain already says what the user was asking it to
 * say. It exists so that case cannot be mistaken for a successful recall this
 * session performed.
 */
export class RecallError extends Error {
  readonly kind: "rejected" | "reverted" | "nothing-to-do" | "failed";
  constructor(kind: RecallError["kind"], message: string) {
    super(message);
    this.name = "RecallError";
    this.kind = kind;
  }
}

/** Maps a revert to the sentence that explains it. */
function revertMessage(name: string): string {
  switch (name) {
    case "EACCannotRevokeRoles":
    case "EACUnauthorizedAccountRoles":
      return "this wallet does not hold ROLE_SET_TEXT_ADMIN on the name — only its owner can pull the role";
    case "DNSDecodingFailed":
      return "the resolver could not decode the name — the DNS encoding is wrong";
    case "EACInvalidAccount":
      return "the agent address was zero";
    case "EACInvalidRoleBitmap":
      return "the role bitmap was rejected by the resolver";
    case "EACMinAssignees":
      return "the resolver requires this role to keep at least one holder on this key";
    default:
      return `the recall reverted with ${name}`;
  }
}

function explain(error: unknown): RecallError {
  if (error instanceof RecallError) return error;
  if (error instanceof BaseError) {
    // 4001 — EIP-1193 "user rejected". Reached through the wallet's own error
    // object, which viem wraps rather than replaces.
    const code = (error.walk() as { code?: number }).code;
    if (code === 4001 || /user (rejected|denied)/i.test(error.shortMessage ?? "")) {
      return new RecallError("rejected", "Signature rejected in the wallet.");
    }

    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name !== undefined) return new RecallError("reverted", revertMessage(name));
      // No name means the revert did not decode against the resolver's ABI.
      // Worth saying plainly rather than guessing: the likeliest cause is that
      // the name now resolves through a different contract than the one read.
      return new RecallError(
        "reverted",
        "the recall reverted and the reason did not decode against the resolver's ABI",
      );
    }
    return new RecallError("failed", error.shortMessage ?? error.message);
  }
  return new RecallError("failed", error instanceof Error ? error.message : "the recall failed");
}

/**
 * The four arguments `authorizeTextRoles` takes.
 *
 * Exported so `scripts/check-recall.ts` simulates the real thing rather than
 * its own idea of it. The name is DNS-encoded here and nowhere else: the
 * resolver namehashes `toName` itself, so a namehash passed in this slot is a
 * valid `bytes` that revokes a role on a name nobody owns.
 */
export function buildRecallArgs(target: RecallTarget): readonly [Hex, string, Address, boolean] {
  return [encodeName(target.name).dnsName, RECORD_KEYS.heartbeat, target.agent, false] as const;
}

/** The two facts a recall depends on, read from the resolver rather than inferred. */
export type RecallPreflight = {
  /** `hasRoles(nameResourceOf(node), ROLE_SET_TEXT_ADMIN, account)` — may this wallet revoke? */
  maySend: boolean;
  /** `hasRoles(textResourceOf(node, heartbeat), ROLE_SET_TEXT, agent)` — is there anything to revoke? */
  agentAuthorized: boolean;
};

/**
 * Asks the resolver both questions before the user is offered a button.
 *
 * Deliberately not "is the connected address the owner". The `owner` on a
 * `Capsule` comes from the `CapsuleMinted` log, which records who owned the
 * name once; the resolver's role table records who may act on it now. Those
 * differ after a transfer, and after any grant the owner made by hand. The
 * resolver's answer is the one the transaction will be judged by, so it is the
 * one the UI asks — and the simulation still has the last word.
 */
export async function recallPreflight(
  publicClient: PublicClient,
  target: RecallTarget,
  account: Address,
): Promise<RecallPreflight> {
  const [maySend, agentAuthorized] = await Promise.all([
    publicClient.readContract({
      address: target.resolver,
      abi: resolverAdminAbi,
      functionName: "hasRoles",
      args: [nameResourceOf(target.node), ROLE_SET_TEXT_ADMIN, account],
    }),
    publicClient.readContract({
      address: target.resolver,
      abi: resolverAdminAbi,
      functionName: "hasRoles",
      args: [textResourceOf(target.node, RECORD_KEYS.heartbeat), ROLE_SET_TEXT, target.agent],
    }),
  ]);
  return { maySend, agentAuthorized };
}

/**
 * The `EACRolesChanged` for this exact revoke out of a receipt's logs, or null.
 *
 * Filtered on all three of emitter, resource and account: a resolver
 * transaction that touched several names — a batched revoke, a multicall —
 * must not have another name's role change read as this one's.
 */
export function rolesChangedFrom(
  logs: { address: string; topics: readonly Hex[] | Hex[]; data: Hex }[],
  resolver: Address,
  resource: bigint,
  account: Address,
): { oldRoles: bigint; newRoles: bigint } | null {
  const events = parseEventLogs({
    abi: resolverAdminAbi,
    eventName: "EACRolesChanged",
    // viem's log type is stricter than what a caller can cheaply produce; the
    // fields parseEventLogs actually reads are the three above.
    logs: logs as never,
  });
  const event = events.find(
    (e) =>
      e.address.toLowerCase() === resolver.toLowerCase() &&
      e.args.resource === resource &&
      e.args.account.toLowerCase() === account.toLowerCase(),
  );
  return event === undefined
    ? null
    : { oldRoles: event.args.oldRoleBitmap, newRoles: event.args.newRoleBitmap };
}

export type RecallArgs = {
  walletClient: WalletClient;
  publicClient: PublicClient;
  target: RecallTarget;
};

export type RecallPhase = "simulating" | "signing" | "mining" | "confirming";

/**
 * Simulates, sends, waits, then reads the permission back.
 *
 * `onPhase` exists so the dialog can print what is happening without this
 * module knowing anything about the dialog.
 */
export async function recallCapsule(
  args: RecallArgs,
  onPhase?: (phase: RecallPhase, detail?: string) => void,
): Promise<RecallReceipt> {
  const { walletClient, publicClient, target } = args;
  const account = walletClient.account;
  if (account === undefined) throw new RecallError("failed", "the wallet client has no account");

  const resource = textResourceOf(target.node, RECORD_KEYS.heartbeat);

  onPhase?.("simulating");
  let request;
  try {
    const simulated = await publicClient.simulateContract({
      address: target.resolver,
      abi: resolverAdminAbi,
      functionName: "authorizeTextRoles",
      args: buildRecallArgs(target),
      account: account.address,
    });
    // `authorizeTextRoles` returns whether it changed anything. `false` means
    // the role is already gone — a transaction that would succeed and do
    // nothing. Stopping here costs the user a wallet popup and some gas.
    if (simulated.result === false) {
      throw new RecallError(
        "nothing-to-do",
        "the agent already holds no write role on this key — there is nothing left to revoke",
      );
    }
    request = simulated.request;
  } catch (error) {
    throw explain(error);
  }

  onPhase?.("signing");
  let hash: Hex;
  try {
    hash = await walletClient.writeContract(request);
  } catch (error) {
    throw explain(error);
  }

  onPhase?.("mining", hash);
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash });
  } catch (error) {
    throw explain(error);
  }

  if (receipt.status !== "success") {
    throw new RecallError("reverted", "the transaction was mined but reverted");
  }

  const changed = rolesChangedFrom(receipt.logs, target.resolver, resource, target.agent);
  if (changed === null) {
    throw new RecallError(
      "failed",
      "the transaction succeeded but emitted no EACRolesChanged for this name — the role was not moved",
    );
  }
  if ((changed.newRoles & ROLE_SET_TEXT) !== 0n) {
    throw new RecallError("failed", "the role change landed but the agent still holds ROLE_SET_TEXT");
  }

  // The event says the role was cleared; this says it is still clear at the
  // block it was mined in. Cheap, and it is the same question the runner's next
  // write will ask. Only after this is the capsule allowed to read as recalled.
  onPhase?.("confirming");
  let stillAuthorized: boolean;
  try {
    stillAuthorized = await publicClient.readContract({
      address: target.resolver,
      abi: resolverAdminAbi,
      functionName: "hasRoles",
      args: [resource, ROLE_SET_TEXT, target.agent],
      blockNumber: receipt.blockNumber,
    });
  } catch (error) {
    throw explain(error);
  }
  if (stillAuthorized) {
    throw new RecallError(
      "failed",
      "the revoke was mined but the resolver still reports the agent as authorized",
    );
  }

  return {
    hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    resource,
    oldRoles: changed.oldRoles,
    newRoles: changed.newRoles,
  };
}
