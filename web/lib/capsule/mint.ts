/**
 * The mint, as one call the browser can make.
 *
 * Client-safe: no env, no node:crypto, no server RPC. Everything it needs
 * arrives as an argument, because the two values that make a mint correct —
 * the agent address and the prompt pointer — are produced by
 * `POST /api/capsule/prepare` and must not be reinvented here.
 *
 * ## Why this simulates first
 *
 * `CapsuleMinter.mint()` does five things in one transaction, and any of them
 * can revert: the label may have been registered between the prepare and the
 * signature, the resolver's admin may have taken the minter's root roles away,
 * an address may be zero. A wallet that sends the transaction anyway shows the
 * user a red "transaction failed" screen after they have paid for the gas that
 * failed. `eth_call` costs nothing and answers the same question, so the only
 * reason to skip it is impatience.
 *
 * The simulation runs from the user's own address, so it is the transaction
 * they are about to send and not an approximation of it.
 *
 * ## Why the result is read from the receipt
 *
 * `simulateContract` returns what `mint()` *would* return, which is convenient
 * and not authoritative — between the call and the transaction the chain moves.
 * The tokenId that ends up in the ENSIP-25 registration key is the one the
 * mined `CapsuleMinted` event carries, so that is the one this returns. If the
 * event is missing the mint is reported as failed even on a successful receipt:
 * a transaction to the right address that emitted nothing is not a capsule.
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
import { minterAbi } from "./chain";
import type { PrepareResult } from "./prepare-client";

export type MintReceipt = {
  hash: Hex;
  node: Hex;
  tokenId: bigint;
  blockNumber: bigint;
  /** Gas the mint actually cost, for the line the launchpad prints. */
  gasUsed: bigint;
};

/**
 * A failure with something the user can act on.
 *
 * The wallet's own message is unusable in a UI — it is a stack of nested viem
 * errors ending in a hex selector — so every case we can name is named, and
 * everything else falls back to viem's short message rather than the full dump.
 */
export class MintError extends Error {
  /** `"rejected"` when the user dismissed the wallet: not worth a red banner. */
  readonly kind: "rejected" | "reverted" | "failed";
  constructor(kind: MintError["kind"], message: string) {
    super(message);
    this.name = "MintError";
    this.kind = kind;
  }
}

/** Maps a revert to the sentence that explains it. */
function revertMessage(name: string, args: readonly unknown[] | undefined): string {
  switch (name) {
    case "InvalidLabel":
      return `the minter rejected the label ${String(args?.[0] ?? "")} — it must be 1–63 bytes`;
    case "ZeroAddress":
      return "the owner or the agent address was zero";
    case "MissingResolverRoles":
      return "the minter no longer holds write roles on the resolver, so it cannot write this name's records";
    // The three below are the setup steps, reported as the step that is missing.
    // The form checks `readiness()` before it offers a mint, so reaching any of
    // them means the parent was reconfigured between that read and this signature —
    // rare, and exactly the case where a bare selector would be baffling.
    case "ParentNotConnected":
      return "this name is no longer connected to Capsule — reconnect it at /connect before minting";
    case "ParentNotOpen":
      return "this name is closed to outside minters — only its own admins can mint here";
    case "ParentLinkBroken":
      return "this name's subregistry is not wired to it on chain, so Capsule cannot issue subnames under it";
    default:
      return `the mint reverted with ${name}`;
  }
}

function explain(error: unknown): MintError {
  if (error instanceof BaseError) {
    // 4001 — EIP-1193 "user rejected". Reached through the wallet's own error
    // object, which viem wraps rather than replaces.
    const code = (error.walk() as { code?: number }).code;
    if (code === 4001 || /user (rejected|denied)/i.test(error.shortMessage ?? "")) {
      return new MintError("rejected", "Signature rejected in the wallet.");
    }

    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name !== undefined) return new MintError("reverted", revertMessage(name, reverted.data?.args));
      // No name means the revert did not decode against the minter's ABI —
      // almost always a revert from the registry underneath it, which is what a
      // label registered since the prepare looks like.
      return new MintError(
        "reverted",
        "the mint reverted — the most likely reason is that this name was registered by someone else since you configured it",
      );
    }
    return new MintError("failed", error.shortMessage ?? error.message);
  }
  return new MintError("failed", error instanceof Error ? error.message : "the mint failed");
}

/**
 * The five arguments `mint()` takes, built from a prepare response.
 *
 * Exported so `scripts/check-mint.ts` can simulate the real thing rather than
 * its own idea of it. The tuple order here is the ABI's, and the ABI's is the
 * struct's: viem encodes a tuple positionally, so an object with the right keys
 * is safe and a reordered one would silently write the Telegram URL into
 * `agent-context`. The check asserts that order against CapsuleMinter.sol.
 *
 * `registry` is the parent, and it comes from the caller rather than from the
 * prepare response on purpose: the prepare route seals a prompt and returns an
 * agent key, and it has no business deciding which name the capsule lands under.
 * The parent is settled in the browser, printed in the signed message as part of
 * the full capsule name, and re-derived from that name by both routes.
 */
export function buildMintParams(registry: Address, prepared: PrepareResult) {
  return [
    registry,
    prepared.label,
    prepared.owner,
    prepared.agent,
    {
      context: prepared.config.context,
      telegramUrl: prepared.config.telegramUrl,
      capsuleEndpoint: prepared.config.capsuleEndpoint,
      model: prepared.config.model,
      runtime: prepared.config.runtime,
      promptPointer: prepared.config.promptPointer,
    },
  ] as const;
}

/**
 * The `CapsuleMinted` event out of a receipt's logs, or null.
 *
 * Filtered by emitting address: a transaction that touched the minter and also
 * something else must not have another contract's event read as this mint.
 */
export function capsuleMintedFrom(
  logs: { address: string; topics: readonly Hex[] | Hex[]; data: Hex }[],
  minter: Address,
): { node: Hex; tokenId: bigint; owner: Address; agent: Address; label: string } | null {
  const events = parseEventLogs({
    abi: minterAbi,
    eventName: "CapsuleMinted",
    // viem's log type is stricter than what a caller can cheaply produce; the
    // fields parseEventLogs actually reads are the three above.
    logs: logs as never,
  });
  const event = events.find((e) => e.address.toLowerCase() === minter.toLowerCase());
  return event === undefined
    ? null
    : {
        node: event.args.node,
        tokenId: event.args.tokenId,
        owner: event.args.owner,
        agent: event.args.agent,
        label: event.args.label,
      };
}

export type MintArgs = {
  walletClient: WalletClient;
  publicClient: PublicClient;
  minter: Address;
  /** The parent's subregistry — which name this capsule goes under. */
  registry: Address;
  /** Straight from the prepare response. Never rebuilt from form state. */
  prepared: PrepareResult;
};

/**
 * Simulates, sends, and waits.
 *
 * `onPhase` exists so the launchpad can print what is happening without this
 * module knowing anything about the launchpad. The phases are the three things
 * that actually take time and the two that need the user.
 */
export async function mintCapsule(
  args: MintArgs,
  onPhase?: (phase: "simulating" | "signing" | "mining", detail?: string) => void,
): Promise<MintReceipt> {
  const { walletClient, publicClient, minter, registry, prepared } = args;
  const account = walletClient.account;
  if (account === undefined) throw new MintError("failed", "the wallet client has no account");

  const params = buildMintParams(registry, prepared);

  onPhase?.("simulating");
  let request;
  try {
    ({ request } = await publicClient.simulateContract({
      address: minter,
      abi: minterAbi,
      functionName: "mint",
      args: params,
      account: account.address,
    }));
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
    throw new MintError("reverted", "the transaction was mined but reverted");
  }

  const event = capsuleMintedFrom(receipt.logs, minter);
  if (event === null) {
    // A successful receipt with no CapsuleMinted is not a capsule. Refusing to
    // report a tokenId we did not read is the difference between "minted" and
    // "a transaction happened".
    throw new MintError("failed", "the transaction succeeded but emitted no CapsuleMinted event");
  }

  return {
    hash,
    node: event.node,
    tokenId: event.tokenId,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
  };
}

/**
 * Can the minter still write records under this parent?
 *
 * A free read, and the one precondition of a mint that is invisible from the
 * form: `CapsuleMinter` writes a name's records with its own root roles on that
 * parent's `PermissionedResolver`, and the resolver's admin can revoke them. If
 * that has happened every mint reverts at the record writes — after the name is
 * already registered.
 *
 * Per parent now, because there is no longer a single resolver to ask about. The
 * launch form gets this from `readiness()` along with everything else and does
 * not call this; it is kept for `scripts/check-mint.ts` and the health route,
 * which check one known parent rather than whichever one a user picked.
 */
export async function minterCanWrite(
  publicClient: PublicClient,
  minter: Address,
  resolver: Address,
): Promise<boolean> {
  try {
    await publicClient.readContract({
      address: minter,
      abi: minterAbi,
      functionName: "checkResolverRoles",
      args: [resolver],
    });
    return true;
  } catch {
    return false;
  }
}
