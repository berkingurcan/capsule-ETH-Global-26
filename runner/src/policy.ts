/**
 * What the agent is allowed to spend, and who decides.
 *
 * The agent has always had a funded wallet — it pays for its own heartbeat. What
 * it has never had is any way for the *model* to reach that wallet, because the
 * key lives in the supervisor and `buildOpenClawEnv` builds the child's
 * environment from nothing. This module is what makes it safe to open a door in
 * that wall: every transaction the model asks for passes through `checkSpend`
 * before anything is signed, and the numbers it checks against come off the
 * chain rather than out of this file.
 *
 * ## The owner sets the limit, on the name, in one transaction
 *
 * `agent-spend-cap` and `agent-spend-allow` are text records on the capsule's
 * own name. `CapsuleMinter.mint` already grants the owner name-level
 * `ROLE_SET_TEXT` and its admin bit, so an owner can write them today, on names
 * that already exist, with no contract change and no redeploy.
 *
 * The agent cannot write them. Its grant is per-key and covers `agent-heartbeat`
 * alone, which is the same boundary that already stops it rewriting its own
 * `agent-prompt` — enforced by `PermissionedResolver`, not by this process. So
 * an agent holding a live write permission on its own name still cannot raise
 * its own spending limit, however the request is phrased and whoever makes it.
 *
 * Set the cap to `0` and within one tick the agent is broke but alive: still
 * authorized, still beating, still answering, and unable to move a wei. That is
 * a different switch from the recall — the recall stops the agent, this one
 * stops only its hands — and having both is the point.
 *
 * ## Everything here fails closed
 *
 * `parseHeartbeatSequence` in records.ts is deliberately tolerant: a capsule
 * must not die because some earlier version of itself wrote a value the parser
 * did not expect. This module inverts that rule, because the failure modes are
 * not symmetrical. A misparsed heartbeat costs a duplicated beat. A misparsed
 * spending cap costs money. So anything unparseable, negative, absurd or simply
 * absent resolves to zero, and zero means no.
 */
import { formatEther, getAddress, isAddressEqual, parseEther, zeroAddress, type Address, type Hex } from "viem";
import { POLICY_KEYS } from "./records.js";

/**
 * How many heartbeats' worth of gas is held back from the agent's own spending.
 *
 * Not a rounding allowance — this is the single most important number in the
 * module. `README.md`'s empty-wallet test exists because a broke agent and a
 * revoked agent both stop writing `agent-heartbeat`, so from the chain alone
 * they are the same event. An agent that could spend itself down to nothing
 * would be manufacturing exactly that confusion, on purpose, with its own
 * hands — the one failure this whole project is built to make impossible.
 *
 * Fifty beats is a fortnight at the production cadence of three a day. Long
 * enough for an owner to notice and top up; short enough that a demo wallet is
 * not mostly reserve.
 */
export const RESERVE_BEATS = 50n;

/**
 * The default per-run ceiling, as a multiple of the per-transaction cap.
 *
 * The cap bounds one transaction. Nothing in it bounds a thousand of them, and
 * the shape of this failure is not a hostile user — it is an ordinary tool loop
 * that misreads a result and retries, which is a thing language models do. So
 * the process keeps its own running total and refuses past this multiple,
 * regardless of what the records say.
 *
 * Deliberately per *run* and not per day: the supervisor holds no state across
 * restarts and inventing a persistent ledger for a hackathon would be a second
 * source of truth that can disagree with the chain. A restart resets it, which
 * is a real limit, and it is written down here rather than papered over.
 */
export const DEFAULT_CEILING_MULTIPLE = 10n;

export type SpendPolicy = {
  /** Max wei per transaction. Zero means the agent cannot spend at all. */
  cap: bigint;
  /** `"any"` when the record is absent — bounded by the cap, never unbounded. */
  allow: "any" | readonly Address[];
  /** What the records actually said, for the log and the agent's status file. */
  capRaw: string;
  allowRaw: string;
  /** Set when a record was present but unreadable. Reported, never thrown. */
  problems: readonly string[];
};

/** What a name with no policy records means: no. */
export const SPEND_DISABLED: SpendPolicy = {
  cap: 0n,
  allow: "any",
  capRaw: "",
  allowRaw: "",
  problems: [],
};

/**
 * Absurdity ceiling on the cap record itself.
 *
 * A fat-fingered `agent-spend-cap` of `1000` on a testnet is not an
 * authorization, it is a typo, and honouring it would drain a faucet wallet in
 * one call. Sepolia ETH has no price; a cap above this is evidence the owner
 * meant something else, so it is refused loudly rather than obeyed quietly.
 */
export const MAX_SANE_CAP = parseEther("10");

/**
 * The records, read.
 *
 * Never throws. Every failure resolves to something safe and appends a problem
 * the caller logs, because the alternative — a capsule that will not boot
 * because its owner typed `0,01` — turns a typo into an outage, and on a
 * dashboard an outage is indistinguishable from a recall.
 */
export function parseSpendPolicy(capRaw: string, allowRaw: string): SpendPolicy {
  const problems: string[] = [];
  const cap = parseCap(capRaw.trim(), problems);
  const allow = parseAllow(allowRaw.trim(), problems);
  return { cap, allow, capRaw: capRaw.trim(), allowRaw: allowRaw.trim(), problems };
}

function parseCap(raw: string, problems: string[]): bigint {
  if (raw === "") return 0n;

  let wei: bigint;
  try {
    wei = parseEther(raw);
  } catch {
    problems.push(`${POLICY_KEYS.spendCap} — "${raw}" is not a decimal ETH amount, spending stays off`);
    return 0n;
  }

  if (wei < 0n) {
    problems.push(`${POLICY_KEYS.spendCap} — "${raw}" is negative, spending stays off`);
    return 0n;
  }
  if (wei > MAX_SANE_CAP) {
    problems.push(
      `${POLICY_KEYS.spendCap} — "${raw}" is above the ${formatEther(MAX_SANE_CAP)} ETH sanity ceiling, spending stays off`,
    );
    return 0n;
  }
  return wei;
}

function parseAllow(raw: string, problems: string[]): "any" | readonly Address[] {
  if (raw === "" || raw === "*") return "any";

  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  const addresses: Address[] = [];
  for (const entry of entries) {
    try {
      addresses.push(getAddress(entry));
    } catch {
      problems.push(`${POLICY_KEYS.spendAllow} — "${entry}" is not an address, ignored`);
    }
  }

  // Every entry was junk. Returning "any" here would widen the policy as a
  // *result* of the owner trying to narrow it, which is the worst possible way
  // to read a malformed allowlist.
  if (addresses.length === 0) {
    problems.push(`${POLICY_KEYS.spendAllow} — no usable addresses, nothing is allowed`);
    return [];
  }
  return addresses;
}

/**
 * One line for the boot log and the agent's own status block.
 *
 * Deliberately carries no on/off word of its own. Three callers state that
 * themselves — the supervisor's log, the agent's status block and the CLI — and
 * a description that also said "off" produced `OFF — off — no agent-spend-cap`.
 * Use `spendHeadline` where the state has not already been said.
 */
export function describePolicy(policy: SpendPolicy): string {
  if (policy.cap === 0n) {
    return policy.capRaw === ""
      ? `no ${POLICY_KEYS.spendCap} record on this name`
      : `${POLICY_KEYS.spendCap} on this name reads "${policy.capRaw}"`;
  }
  const where =
    policy.allow === "any" ? "any address" : `${policy.allow.length} allowed address${policy.allow.length === 1 ? "" : "es"}`;
  return `${formatEther(policy.cap)} ETH per transaction · ${where}`;
}

/** `describePolicy` with the state in front, for a log line that stands alone. */
export function spendHeadline(policy: SpendPolicy): string {
  return `${policy.cap > 0n ? "on" : "off"} · ${describePolicy(policy)}`;
}

export type SpendRequest = {
  /** Null is contract creation, which is refused — see below. */
  to: Address | null;
  value: bigint;
  /** Empty for a plain transfer. Non-empty makes this a contract call. */
  data: Hex;
};

export type SpendContext = {
  policy: SpendPolicy;
  /** The agent's balance right now. */
  balance: bigint;
  gasPrice: bigint;
  /** What this transaction is estimated to burn, from `estimateGas`. */
  gasLimit: bigint;
  /** Total value moved by this process so far, this run. */
  spentThisRun: bigint;
  /** Overrides `DEFAULT_CEILING_MULTIPLE` when the operator set one. */
  ceiling: bigint | undefined;
  /** The name's own resolver. The agent may never transact against it. */
  resolver: Address;
  /** How much gas one heartbeat costs, so the reserve can be priced. */
  beatGas: bigint;
};

export type SpendVerdict =
  | { ok: true; reserve: bigint; ceiling: bigint }
  | { ok: false; reason: string };

/**
 * May this transaction be signed?
 *
 * Ordered cheapest and most categorical first, so the reason the agent is told
 * is the most useful one rather than the first one that happened to fail. An
 * agent refused for six reasons at once should hear about the cap, not about
 * the gas reserve.
 *
 * Everything here is a supervisor-side check and none of it is enforced by the
 * chain. That is stated plainly rather than dressed up: the chain enforces who
 * may write which record, and it has no opinion about how an EOA spends its own
 * ETH. What the chain does enforce is the part that matters — that the agent
 * cannot edit the records these limits are read from.
 */
export function checkSpend(request: SpendRequest, context: SpendContext): SpendVerdict {
  const { policy } = context;

  // Contract creation. Refused outright and not policy-gated, because there is
  // no `to` to check against an allowlist and no way to describe to an owner
  // what was deployed. An agent that needs to deploy something is a feature
  // request, not a spending decision.
  if (request.to === null || isAddressEqual(request.to, zeroAddress)) {
    return { ok: false, reason: "contract creation is not available to a capsule" };
  }

  // The resolver holds this agent's identity, its config and the one record it
  // may write. `PermissionedResolver` would refuse anything beyond
  // `agent-heartbeat` anyway — but a refusal that arrives as an on-chain revert
  // costs gas and, worse, reaches `classifyHeartbeatFailure` looking exactly
  // like a revocation. Cheaper and clearer to never send it.
  if (isAddressEqual(request.to, context.resolver)) {
    return {
      ok: false,
      reason: `${request.to} is this capsule's own resolver — records are written by the supervisor, never by a wallet call`,
    };
  }

  if (request.value < 0n) return { ok: false, reason: "value must not be negative" };

  if (policy.cap === 0n) {
    return {
      ok: false,
      reason:
        policy.capRaw === ""
          ? `spending is off — no ${POLICY_KEYS.spendCap} record on this name. Your owner enables it with one setText, and only your owner can.`
          : `spending is off — ${POLICY_KEYS.spendCap} on this name reads "${policy.capRaw}". Only your owner can change it.`,
    };
  }

  if (request.value > policy.cap) {
    return {
      ok: false,
      reason: `${formatEther(request.value)} ETH is over the ${formatEther(policy.cap)} ETH per-transaction cap set by ${POLICY_KEYS.spendCap}. Only your owner can raise it.`,
    };
  }

  const isCall = request.data !== "0x" && request.data.length > 2;

  // "Anywhere" is a statement about plain transfers, and only they are bounded
  // by the ETH cap. Calldata this runner does not interpret can move an ERC-20
  // balance, approve a spender, or call something that does either — none of
  // which the cap above says anything about. So a contract call needs its target
  // named on the allowlist, which makes enabling one a deliberate act by the
  // owner rather than a side effect of turning spending on.
  if (isCall && policy.allow === "any") {
    return {
      ok: false,
      reason: `contract calls need ${request.to} named in ${POLICY_KEYS.spendAllow} — a spend cap bounds ETH, and calldata can move things it does not measure`,
    };
  }

  if (policy.allow !== "any") {
    const permitted = policy.allow.some((address) => isAddressEqual(address, request.to as Address));
    if (!permitted) {
      return {
        ok: false,
        reason: `${request.to} is not in ${POLICY_KEYS.spendAllow} on this name. Only your owner can add it.`,
      };
    }
  }

  const ceiling = context.ceiling ?? policy.cap * DEFAULT_CEILING_MULTIPLE;
  if (context.spentThisRun + request.value > ceiling) {
    return {
      ok: false,
      reason: `this run has already moved ${formatEther(context.spentThisRun)} ETH and the ceiling is ${formatEther(ceiling)} ETH — a restart clears it, and a loop is the usual cause`,
    };
  }

  // Last, because it is the only check whose answer changes minute to minute
  // and the only one that is not about permission at all.
  const reserve = context.beatGas * context.gasPrice * RESERVE_BEATS;
  const gasCost = context.gasLimit * context.gasPrice;
  const needed = request.value + gasCost + reserve;

  if (context.balance < needed) {
    const spendable = context.balance > reserve + gasCost ? context.balance - reserve - gasCost : 0n;
    return {
      ok: false,
      reason: `only ${formatEther(spendable)} ETH is spendable — ${formatEther(reserve)} ETH is held back for ${RESERVE_BEATS} heartbeats, and an agent that cannot beat looks exactly like a revoked one`,
    };
  }

  return { ok: true, reserve, ceiling };
}

/**
 * What is actually available to spend right now, for the status block.
 *
 * Same arithmetic as the last check in `checkSpend`, minus the gas for a
 * specific transaction, which is not known until there is one. Reported rather
 * than the raw balance because the raw balance is a number the agent would
 * otherwise quote to its owner as though it were spendable.
 */
export function spendable(args: {
  balance: bigint;
  gasPrice: bigint;
  beatGas: bigint;
  policy: SpendPolicy;
}): bigint {
  const reserve = args.beatGas * args.gasPrice * RESERVE_BEATS;
  const free = args.balance > reserve ? args.balance - reserve : 0n;
  return free < args.policy.cap ? free : args.policy.cap;
}
