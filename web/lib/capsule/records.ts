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
 * ⚠️ Phase 1: the four keys that already exist on chain still hold their DOTTED
 * values. Names minted against CapsuleMinter 0xe609aE… carry `agent.model` and
 * friends, and renaming here without redeploying would silently break every
 * live capsule. The kebab-case rename is Phase 2, and it happens in this file,
 * its twin, and CapsuleMinter.sol in one commit. Keys marked NEW have never
 * been written, so they carry their final ENSIP values already.
 */

/**
 * Every text key a capsule name carries.
 *
 * The property names are ours; the string values are the contract with the
 * chain. Never inline a value from this table — import the key.
 */
export const RECORD_KEYS = {
  /** ENSIP-27 node classification. NEW. */
  class: "class",
  /** ENSIP-27 pointer to the JSON Schema for our own keys. NEW. */
  schema: "schema",
  /** ENSIP-26 free-form description of the agent. NEW. */
  context: "agent-context",
  /** ENSIP-26. The human-facing interface — for a capsule, the Telegram bot. NEW. */
  endpointWeb: "agent-endpoint[web]",
  /** ENSIP-26 syntax, our own protocol tag. The control plane. Phase 2 → "agent-endpoint[capsule]". */
  endpointCapsule: "agent.endpoint",
  /** Our schema. Phase 2 → "agent-model". */
  model: "agent.model",
  /** Our schema. `openclaw`. NEW. */
  runtime: "agent-runtime",
  /** Our schema. A pointer such as `cap_8f3d1a`, never the prompt body. Phase 2 → "agent-prompt". */
  prompt: "agent.prompt",
  /** Our schema. The only key the agent may write. Phase 2 → "agent-heartbeat". */
  heartbeat: "agent.heartbeat",
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

/** Every text key read in the boot multicall, in the order the results come back. */
export const TEXT_KEYS = [...REQUIRED_TEXT_KEYS, HEARTBEAT_KEY] as const;

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
 * `CapsuleMinter.registrationKey()` (Phase 2), which derives it from
 * `block.chainid` and `address(this)` so it survives a redeploy. Never hardcode
 * the result: it changes every time the minter is redeployed.
 */
export function registrationKey(erc7930Registry: string, agentId: string | bigint): string {
  return `agent-registration[${erc7930Registry}][${agentId}]`;
}

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
