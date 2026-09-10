/**
 * The record keys, spelled once.
 *
 * Four things must agree exactly on these strings — `CapsuleMinter.sol`, the EAC
 * grant it issues, the runner, and the dashboard — and a mismatch does not fail
 * loudly. `PermissionedResolver` reverts against the *name-level* resource
 * whichever key was denied, so authorising `agent.heartbeat` and writing
 * `agent-heartbeat` produces the same bytes as a revocation. That bug costs an
 * afternoon and looks like a kill switch working.
 *
 * So: one module per language, and a script that proves they match.
 *
 *   contracts/src/CapsuleMinter.sol   KEY_* constants
 *   runner/src/records.ts             this file
 *   web/lib/capsule/records.ts        a byte-identical copy
 *
 * The two TypeScript copies are byte-identical on purpose. The runner ships as
 * an independent container and cannot take a workspace dependency on the web
 * app, so the file is duplicated and `npm run check:records` (in web/) asserts
 * both copies and the Solidity constants still say the same thing.
 *
 * Spec: ../../Branding-ENSClaw/RECORDS.md
 *
 * Every attribute is kebab-case, because ENSIP-27 requires it of schema
 * attributes and reserves dot notation for ENSIP-5 namespacing. Parameters go in
 * square brackets, which ENSIP-26 and ENSIP-27 both define, so a client that
 * understands the notation can enumerate protocols it has never heard of.
 *
 * Names minted before 2026-09-08 carry the dotted spellings (`agent.model` and
 * friends) and are NOT migrated — they are testnet names on a superseded minter.
 */

/**
 * Every text key a capsule name carries.
 *
 * The property names are ours; the string values are the contract with the
 * chain. Never inline a value from this table — import the key.
 */
export const RECORD_KEYS = {
  /** ENSIP-27 node classification. */
  class: "class",
  /** ENSIP-27 pointer to the JSON Schema for our own keys. */
  schema: "schema",
  /** ENSIP-26 free-form description of the agent. */
  context: "agent-context",
  /** ENSIP-26. The human-facing interface — for a capsule, the Telegram bot. */
  endpointWeb: "agent-endpoint[web]",
  /** ENSIP-26 syntax, our own protocol tag. The control plane. */
  endpointCapsule: "agent-endpoint[capsule]",
  /** Our schema. e.g. `claude-opus-5`. */
  model: "agent-model",
  /** Our schema. `openclaw`. */
  runtime: "agent-runtime",
  /** Our schema. A pointer such as `cap_8f3d1a`, never the prompt body. */
  prompt: "agent-prompt",
  /** Our schema. The only key the agent may write. */
  heartbeat: "agent-heartbeat",
} as const;

export type RecordKeyName = keyof typeof RECORD_KEYS;

/**
 * The one key the agent's own key may write.
 *
 * Everything else is the owner's. That is not a convention enforced in a
 * backend — it is a per-key EAC grant on `PermissionedResolver`, which is why
 * an agent holding a live write permission on its own name still cannot edit
 * its own instructions.
 */
export const HEARTBEAT_KEY = RECORD_KEYS.heartbeat;

/**
 * The spending policy, as records on the name.
 *
 * Deliberately NOT in `RECORD_KEYS`, and the distinction is load-bearing rather
 * than tidy: `RECORD_KEYS` is what `CapsuleMinter` writes at mint time, and
 * `check-records.ts` asserts every one of them has a `KEY_*` constant in the
 * Solidity — a key the minter never writes is a key no name would ever carry.
 * These two are the other kind of key. The minter does not write them, no
 * deployed contract knows they exist, and a capsule minted before they did
 * behaves exactly as it always has.
 *
 * They work anyway because `CapsuleMinter.mint` already grants the owner
 * name-level `ROLE_SET_TEXT` plus its admin bit on their own name. So an owner
 * can set these today, on names that already exist, with one `setText` and no
 * redeploy — and the agent cannot, because its own grant is per-key and covers
 * `agent-heartbeat` alone.
 *
 * That asymmetry is the whole design. The agent holds a live write permission
 * on its own name and still cannot raise its own spending limit, for the same
 * reason and through the same mechanism that it cannot rewrite its own
 * `agent-prompt`. Enforced by the resolver, not by the process holding the key.
 */
export const POLICY_KEYS = {
  /**
   * The gate. A decimal ETH amount — `"0.01"` — and the most a single
   * transaction may move. Absent, empty or unparseable means zero, which means
   * the agent cannot spend at all. Spending is off until an owner turns it on.
   */
  spendCap: "agent-spend-cap",
  /**
   * The narrowing. A comma-separated list of addresses the agent may send to.
   * Absent means "anywhere", which is safe only because the cap above already
   * bounds every single transfer; present means those addresses and no others.
   *
   * Contract calls are the exception and are never covered by "anywhere" — see
   * `checkSpend` in policy.ts. Calldata this runner does not interpret can move
   * value the ETH cap says nothing about, so the target has to be named.
   */
  spendAllow: "agent-spend-allow",
} as const;

/** Read every tick, in the same multicall as everything else. */
export const POLICY_TEXT_KEYS = [POLICY_KEYS.spendCap, POLICY_KEYS.spendAllow] as const;

/**
 * Records the runner refuses to boot without.
 *
 * The heartbeat is deliberately absent: a freshly minted name has never been
 * written by its agent, so requiring it would make every capsule fail its first
 * boot. `class`, `schema`, `agent-context` and `agent-endpoint[web]` are absent
 * because a capsule with no description is misconfigured, not broken.
 */
export const REQUIRED_TEXT_KEYS = [
  RECORD_KEYS.model,
  RECORD_KEYS.endpointCapsule,
  RECORD_KEYS.prompt,
] as const;

/**
 * Every text key read in the boot multicall, in the order the results come back.
 *
 * The policy keys ride along on the end rather than in a second call. They are
 * read on every tick for the same reason the model reference is: the owner
 * edits them from a wallet on a live agent, and a cap lowered to zero has to
 * take effect within one tick or it is not a kill switch, it is a request.
 */
export const TEXT_KEYS = [
  ...REQUIRED_TEXT_KEYS,
  HEARTBEAT_KEY,
  ...POLICY_TEXT_KEYS,
] as const;

/**
 * ENSIP-27 node classification. Pascal-case, from the spec's recommended
 * vocabulary, and it must equal the served schema's `title`.
 */
export const CLASS_VALUE = "Agent";

/**
 * The `title` of `capsule-agent-v1.json`. ENSIP-27 requires it to match the
 * `class` value, so the two are one constant expressed twice.
 */
export const SCHEMA_TITLE = CLASS_VALUE;

/**
 * The only keys our ENSIP-27 schema is allowed to declare — the ones no ENSIP
 * defines.
 *
 * `class`, `schema`, `agent-context`, `agent-endpoint[*]` and `addr` are owned
 * by ENSIP-5/26/27 and must not be redeclared. `agent-registration[…][…]` is
 * excluded for a second reason: ENSIP-27's attribute grammar is
 * `^key-name(\[[^\]]+\])?$` — one bracket group — and ENSIP-25's key has two.
 */
export const OWN_SCHEMA_KEYS = [
  RECORD_KEYS.model,
  RECORD_KEYS.runtime,
  RECORD_KEYS.prompt,
  RECORD_KEYS.heartbeat,
] as const;

/**
 * ENSIP-25 verification key: `agent-registration[<registry>][<agentId>]`.
 *
 * `registry` is the minter as an ERC-7930 interoperable address, `agentId` its
 * `tokenId` in decimal. Both halves come off the chain — `registry` from
 * `CapsuleMinter.REGISTRY_INTEROP_ADDRESS()`, which the contract derives at
 * construction from `block.chainid` and `address(this)` so it survives a
 * redeploy. Never hardcode the result: it changes every time the minter is
 * redeployed. `CapsuleMinter.registrationKey(tokenId)` returns the whole string
 * if you would rather not build it here.
 */
export function registrationKey(erc7930Registry: string, agentId: string | bigint): string {
  return `agent-registration[${erc7930Registry}][${agentId}]`;
}

/** The ENSIP-25 record value. Non-empty is all the spec asks; presence is the claim. */
export const REGISTRATION_VALUE = "1";

/**
 * The heartbeat value: a monotonic counter, never a timestamp.
 *
 * A counter means a write must read the previous value first, which is free —
 * the boot multicall already returns it. On-chain last-seen comes from the
 * subgraph's `block.timestamp`, not from this string.
 */
export function heartbeatValue(sequence: number): string {
  return `beat-${sequence}`;
}

/**
 * `"beat-7"` → `7`, `""` → `0`.
 *
 * Deliberately tolerant of anything else. A capsule must not die because some
 * earlier version of itself, or a curious owner, wrote a value this parser did
 * not expect.
 */
export function parseHeartbeatSequence(raw: string): number {
  const match = /(\d+)\s*$/.exec(raw);
  if (match === null) return 0;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
