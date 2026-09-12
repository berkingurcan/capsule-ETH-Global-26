/**
 * The spending limit, set by the owner at launch.
 *
 * A capsule's agent can ask its supervisor to send a transaction, and the
 * supervisor decides against two text records on the capsule's own name:
 * `agent-spend-cap` and `agent-spend-allow`. `CapsuleMinter` writes neither —
 * no deployed minter knows the keys exist — so without this module every
 * newly minted capsule boots with spending off and stays that way until
 * somebody sends a `setText` by hand.
 *
 * The owner can send it because `mint()` already grants them
 * `OWNER_NAME_ROLES` on their own name: `ROLE_SET_TEXT | ROLE_SET_TEXT_ADMIN`,
 * name-level. That is the same grant the recall runs on, and it is why a
 * spending policy needed no contract change and no redeploy.
 *
 * On the ENS hackathon deployment that sentence is only half true, and the
 * difference is worth stating rather than discovering: `_registerAndDelegate`
 * takes the `parent.inode` branch there and grants the capsule owner nothing,
 * because that resolver revision has no name-scoped grant to make. What lets an
 * owner write this record there is the root `ROLE_SET_TEXT` they hold from
 * having deployed their own resolver in /connect — so it works for a parent you
 * own, and not for somebody else's parent you were merely allowed to mint under.
 *
 * ## Two resolver revisions, two spellings of the same write
 *
 * Both deployments are live on Sepolia at once and a capsule's parent sits on
 * one of them:
 *
 *   beta       setText(bytes32 node, string key, string value)
 *   hackathon  setText(bytes name,   string key, string value)
 *
 * Not a superset — a different selector. Sending the beta shape to a hackathon
 * resolver is not a revert with a reason, it is a call to a function that is not
 * there, and the launchpad reports it as a warning and mints anyway. The result
 * is a capsule whose owner typed a limit, paid nothing, and got no record. So
 * the revision is probed here rather than assumed, exactly as `recall.ts` and
 * `CapsuleMinter.connectParent` probe it.
 *
 * ## A second transaction, and deliberately not part of the mint
 *
 * The launchpad's promise is one signature and one transaction per capsule.
 * This adds a second transaction, and only when the owner asked for one: leave
 * the field empty and nothing is sent, which is also the safe default, because
 * a capsule with no cap cannot spend.
 *
 * It is sent *after* the mint rather than before because the name does not
 * exist until the mint lands — there is nothing to write a record on. That
 * ordering has a consequence worth stating: a rejected or failed spend-cap
 * transaction leaves a perfectly good capsule that simply cannot spend yet. The
 * launchpad reports it as a warning and never as a failed mint, and the owner
 * can set it later from a wallet.
 *
 * ## The rules here are a subset of the runner's
 *
 * `runner/src/policy.ts` is authoritative — it is what actually refuses to
 * sign, and it re-reads these records off the chain every tick. This module
 * exists so the form rejects a value the agent would ignore, rather than
 * letting an owner pay gas to write a cap that silently means zero.
 *
 * `npm run check:records` asserts the one number that could drift.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { BaseError, ContractFunctionRevertedError, parseEther } from "viem";
import { inodeResolverAbi, resolverTextAbi } from "./chain";
import { POLICY_KEYS } from "./records";
import { encodeName } from "./resolve";

/**
 * The largest cap the runner will honour, in ETH.
 *
 * Mirrors `MAX_SANE_CAP` in `runner/src/policy.ts`, where the reasoning lives:
 * Sepolia ETH has no price, so a cap above this is evidence of a typo rather
 * than an authorization, and the runner refuses it rather than obeying it.
 *
 * Duplicated because the web app and the runner cannot import each other — the
 * runner ships as an independent container. `check-records.ts` reads the
 * constant out of the runner's source and fails if these two disagree, which is
 * the same guard the record keys already have.
 */
export const MAX_SPEND_CAP_ETH = "10";

/**
 * Everything wrong with a spending cap, as the runner would see it.
 *
 * An empty string is not a problem — it is the default, and it means the
 * capsule launches unable to spend. That is the state every capsule minted
 * before this feature existed is in, and it is a fine place to be.
 */
export function spendCapProblems(raw: string): string[] {
  const value = raw.trim();
  if (value === "") return [];

  let wei: bigint;
  try {
    wei = parseEther(value);
  } catch {
    return ["must be a decimal amount of ETH, such as 0.01"];
  }

  if (wei < 0n) return ["must not be negative"];
  if (wei > parseEther(MAX_SPEND_CAP_ETH)) {
    return [`must be at most ${MAX_SPEND_CAP_ETH} ETH — above that the agent refuses it as a typo`];
  }
  return [];
}

/** Whether a draft's value would actually turn spending on. */
export function spendCapEnables(raw: string): boolean {
  const value = raw.trim();
  if (value === "" || spendCapProblems(value).length > 0) return false;
  try {
    return parseEther(value) > 0n;
  } catch {
    return false;
  }
}

export class SpendCapError extends Error {
  /** `"rejected"` when the user dismissed the wallet: not worth a red banner. */
  readonly kind: "rejected" | "denied" | "reverted" | "failed";
  constructor(kind: SpendCapError["kind"], message: string) {
    super(message);
    this.name = "SpendCapError";
    this.kind = kind;
  }
}

/**
 * The wallet's error, as a sentence.
 *
 * Same shape as `recall.ts`'s: viem hands back a stack of nested errors ending
 * in a hex selector, which is unusable in a UI. The one case worth naming is
 * the role check, because it is the only failure an owner can act on and the
 * only one that means something specific.
 */
function explain(error: unknown): SpendCapError {
  if (error instanceof BaseError) {
    if (/rejected|denied|User denied/i.test(error.shortMessage)) {
      return new SpendCapError("rejected", "Transaction rejected in the wallet.");
    }
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      if (reverted.data?.errorName === "EACUnauthorizedAccountRoles") {
        return new SpendCapError(
          "denied",
          "This wallet cannot write records on that name — check you are connected as the account that minted it, and that the parent is a name you own rather than one you were allowed to mint under.",
        );
      }
      return new SpendCapError("reverted", reverted.data?.errorName ?? reverted.shortMessage);
    }
    return new SpendCapError("failed", error.shortMessage);
  }
  return new SpendCapError("failed", error instanceof Error ? error.message : "the transaction failed");
}

export type SpendCapPhase = "simulating" | "signing" | "mining";

export type SetSpendCapArgs = {
  walletClient: WalletClient;
  publicClient: PublicClient;
  /** The name's own resolver, from `ParentStatus`. Discovered, never constant. */
  resolver: Address;
  /** The capsule's namehash, straight off the mint receipt. */
  node: Hex;
  /**
   * The capsule's full name — `"trader.testiki.eth"`.
   *
   * What the hackathon resolver addresses records by, once DNS-encoded. Passed
   * in rather than derived from `node`, because a namehash is one-way: there is
   * nothing to walk back to a name from.
   */
  name: string;
  /** A decimal ETH amount. Validated by `spendCapProblems` before this is called. */
  cap: string;
};

export type SpendCapReceipt = {
  hash: Hex;
  cap: string;
  blockNumber: bigint;
};

/**
 * Which resolver revision this capsule's name is served by.
 *
 * `getRecordCount()` exists only on the ENS hackathon deployment's revision, so
 * an answer identifies it and a revert means the beta. One read before a
 * transaction the owner is about to sign, which is the cheapest possible
 * insurance against sending a selector the resolver does not have — and that
 * failure is silent in the worst way, because the launchpad is designed to warn
 * rather than fail when the cap does not land.
 */
async function usesInodeResolver(
  publicClient: PublicClient,
  resolver: Address,
): Promise<boolean> {
  try {
    await publicClient.readContract({
      address: resolver,
      abi: inodeResolverAbi,
      functionName: "getRecordCount",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `agent-spend-cap` on a freshly minted capsule.
 *
 * Simulates first, for the reason every write in this codebase does: a denied
 * `setText` reports only "failed to estimate gas" through a wallet, and
 * `simulateContract` runs the same role check as an `eth_call` and hands back
 * the decoded custom error for free.
 *
 * Only the cap is written. `agent-spend-allow` is left unset on purpose — its
 * absence means "any address", which is bounded because the cap bounds every
 * transfer, and an allowlist is a thing an owner narrows to later rather than
 * something a launch form should be guessing at. Contract calls are refused
 * outright while it is unset, which is the runner's rule and not this one.
 */
export async function setSpendCap(
  args: SetSpendCapArgs,
  onPhase?: (phase: SpendCapPhase, detail?: string) => void,
): Promise<SpendCapReceipt> {
  const { walletClient, publicClient, resolver, node, name, cap } = args;
  const account = walletClient.account;
  if (account === undefined) throw new SpendCapError("failed", "the wallet client has no account");

  const value = cap.trim();
  const inode = await usesInodeResolver(publicClient, resolver);

  onPhase?.("simulating");
  let request;
  try {
    /* Two deployments, two spellings of the same write. The hackathon revision
       addresses records by DNS wire name and namehashes it itself, so `node` has
       no slot in that call — passing it as the `bytes` would encode cleanly and
       write a record on a name nobody owns. */
    const simulated = inode
      ? await publicClient.simulateContract({
          address: resolver,
          abi: inodeResolverAbi,
          functionName: "setText",
          args: [encodeName(name).dnsName, POLICY_KEYS.spendCap, value],
          account: account.address,
        })
      : await publicClient.simulateContract({
          address: resolver,
          abi: resolverTextAbi,
          functionName: "setText",
          args: [node, POLICY_KEYS.spendCap, value],
          account: account.address,
        });
    request = simulated.request;
  } catch (error) {
    throw explain(error);
  }

  onPhase?.("signing");
  let hash: Hex;
  try {
    hash = await walletClient.writeContract(request as never);
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
    throw new SpendCapError("reverted", "the transaction was mined but reverted");
  }

  return { hash, cap: value, blockNumber: receipt.blockNumber };
}
