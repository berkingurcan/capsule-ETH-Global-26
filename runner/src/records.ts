/**
 * The record keys, spelled once.
 *
 * These strings are a wire contract with three other places: the `KEY_*` constants in
 * `contracts/src/CapsuleMinter.sol`, the EAC grant the minter makes on chain, and
 * `web/lib/capsule/records.ts`. They must agree exactly, and the failure mode when they
 * do not is the worst one in this system:
 *
 *   The resolver derives a per-key resource from the key string, but `setText` reverts
 *   against the NAME-level resource whichever key was denied. So a runner writing
 *   `agent-heartbeat` against a name that authorised `agent.heartbeat` gets back a
 *   byte-identical `EACUnauthorizedAccountRoles` to the one a revoked agent gets — and
 *   halts, reporting a revocation that never happened.
 *
 * Hence: one module, no string literals anywhere else, and `npm run check:wire` on the
 * web side re-derives these from this file.
 *
 * The naming is not ours. ENSIP-27 requires kebab-case for schema attributes and reserves
 * `class` and `schema`; ENSIP-26 defines `agent-context` and the bracket-parameterised
 * `agent-endpoint[<protocol>]`. Dots are gone from every key as of 2026-09-08.
 */

/** ENSIP-27 node classification. Every capsule is an `Agent`. */
export const KEY_CLASS = "class";

/** ENSIP-27 pointer to the JSON Schema describing the keys below that no ENSIP defines. */
export const KEY_SCHEMA = "schema";

/** ENSIP-26. Free-form prose: what this agent is, for any client that resolves the name. */
export const KEY_CONTEXT = "agent-context";

/** ENSIP-26 `agent-endpoint[<protocol>]`. */
export function endpointKey(protocol: string): string {
  return `agent-endpoint[${protocol}]`;
}

/** The Capsule control plane — prompt and sealed credentials. Required to boot. */
export const KEY_ENDPOINT_CAPSULE = endpointKey("capsule");

/** The human-facing interface. For a Capsule agent that is its Telegram bot. */
export const KEY_ENDPOINT_WEB = endpointKey("web");

export const KEY_MODEL = "agent-model";
export const KEY_RUNTIME = "agent-runtime";

/** A pointer such as "cap_8f3d1a". Never the prompt body. */
export const KEY_PROMPT = "agent-prompt";

/**
 * The one key the agent may write, and the one it is probed against.
 *
 * It appears in three places — the write, the config read, and the owner's
 * `authorizeTextRoles` grant. See the module comment for why that matters.
 */
export const KEY_HEARTBEAT = "agent-heartbeat";

/**
 * The ENSIP-27 `class` value every capsule carries. Pascal-case, from the ENSIP's own
 * recommended vocabulary — the one key in this file that is not kebab-case, because it is
 * a value rather than an attribute name.
 *
 * The runner does not read `class`; it is here because this module is the shared
 * vocabulary, and a constant that exists on only one side of a copied contract is the
 * kind of asymmetry `check:wire` is meant to catch.
 */
export const CLASS_AGENT = "Agent";

/** The only runtime Capsule ships today. `agent-runtime` naming anything else is fatal. */
export const RUNTIME_OPENCLAW = "openclaw";

/** Records the runner refuses to boot without. */
export const REQUIRED_KEYS = [KEY_MODEL, KEY_ENDPOINT_CAPSULE, KEY_PROMPT] as const;

/** Everything read in the boot multicall, required or not. */
export const READ_KEYS = [
  ...REQUIRED_KEYS,
  KEY_HEARTBEAT,
  KEY_RUNTIME,
  KEY_CONTEXT,
  KEY_ENDPOINT_WEB,
] as const;
