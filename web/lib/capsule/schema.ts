/**
 * `capsule-agent-v1.json` — the ENSIP-27 schema every Capsule name points at.
 *
 * ENSIP-27 lets a name declare attribute keys no ENSIP defines, on one
 * condition: `schema` must hold the URI of a JSON Schema describing them. Four
 * of our keys are ours — `agent-model`, `agent-runtime`, `agent-prompt`,
 * `agent-heartbeat` — so this is the document that makes them legible to a
 * client that has never heard of Capsule.
 *
 * It is a **published, permanent artifact**, which is the only unusual thing
 * about it. `CapsuleMinter` takes the URI as a constructor argument and writes
 * it into every name it mints, so a name minted today points here forever. The
 * document may gain description text; it may not change what a key means. That
 * is what the `v1` in the filename is for — a breaking change is
 * `capsule-agent-v2.json` and a new minter deployment, never an edit.
 *
 * Served by `app/schema/capsule-agent-v1.json/route.ts`. Kept in a module of
 * its own rather than inline in the route so `npm run check:records` can assert
 * the document against `RECORD_KEYS` without starting a server.
 *
 * Spec and reasoning: ../../../Branding-ENSClaw/RECORDS.md, "ENSIP-27".
 */
import {
  HEARTBEAT_KEY,
  OWN_SCHEMA_KEYS,
  RECORD_KEYS,
  SCHEMA_TITLE,
} from "./records";

/**
 * The path this document is served at, relative to the deployment origin.
 *
 * Exported because it is half of `CAPSULE_SCHEMA_URI` — the constructor
 * argument in `contracts/.env` must be `<publicUrl>${SCHEMA_PATH}`, and a
 * mismatch is invisible until someone follows the record and gets a 404.
 */
export const SCHEMA_PATH = "/schema/capsule-agent-v1.json";

/** JSON Schema dialect. 2020-12, as ENSIP-27 specifies. */
export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * One property definition. `recordType` is ENSIP-27's own annotation keyword —
 * it says which ENS record carries the value. Every key here is a text record;
 * `addr` is the only non-text key a capsule has and ENSIP-1/9 owns it, so it is
 * not in this document.
 */
type Attribute = {
  type: "string";
  recordType: "text";
  description: string;
  pattern?: string;
  enum?: readonly string[];
  minLength?: number;
  examples?: readonly string[];
};

/**
 * The four attributes, in the order `OWN_SCHEMA_KEYS` lists them.
 *
 * Keyed by the record key itself rather than by a friendly name, and typed so
 * that adding a key to `OWN_SCHEMA_KEYS` without describing it here is a
 * compile error. The failure this prevents is a schema that silently stops
 * describing a record we ship — which no test would otherwise catch, because
 * the document would still be valid JSON Schema.
 */
const ATTRIBUTES: Record<(typeof OWN_SCHEMA_KEYS)[number], Attribute> = {
  [RECORD_KEYS.model]: {
    type: "string",
    recordType: "text",
    description:
      "Which model answers, as `<provider>/<model>`. OpenClaw's own model-reference " +
      "syntax, passed to the runtime verbatim. The provider is everything before the " +
      "first separator; a reference may carry more than one, as in " +
      "`openrouter/anthropic/claude-sonnet-4-6`. No API key appears on chain — the " +
      "provider named here selects which sealed credential the control plane will " +
      "serve to the agent.",
    // Mirrors parseModelRef() in providers.ts: a non-empty provider, a
    // separator, a non-empty remainder. check-records.ts asserts the two agree
    // on the same fixtures, because a record that boots but fails validation
    // (or the reverse) is worse than either failure alone.
    pattern: "^[^/]+/.+$",
    examples: [
      "anthropic/claude-opus-5",
      "openai/gpt-5.6-sol",
      "google/gemini-3.1-pro-preview",
      "deepseek/deepseek-v4-flash",
    ],
  },
  [RECORD_KEYS.runtime]: {
    type: "string",
    recordType: "text",
    description:
      "The agent runtime the capsule runs. `openclaw` is the only value this version " +
      "of the schema defines; a second runtime is a v2 document, not an edit to this " +
      "one, because names already minted point here permanently.",
    enum: ["openclaw"],
    examples: ["openclaw"],
  },
  [RECORD_KEYS.prompt]: {
    type: "string",
    recordType: "text",
    description:
      "An opaque pointer to the agent's instructions, such as `cap_8f3d1a`. The prompt " +
      "body is never on chain: the pointer is a claim check, redeemed at " +
      "`agent-endpoint[capsule]` by an agent that signs as this name's `addr`. Changing " +
      "this record changes the agent's instructions on its next tick.",
    // Deliberately no pattern. The generator makes "cap_" + 6 hex, but nothing
    // in the system validates that shape and the prompt route treats the ref as
    // opaque — pinning a format here would publish an implementation detail as
    // a promise, and invalidate refs that already work.
    minLength: 1,
    examples: ["cap_8f3d1a"],
  },
  [RECORD_KEYS.heartbeat]: {
    type: "string",
    recordType: "text",
    description:
      "Liveness, as a monotonic counter — `beat-<n>`, never a timestamp, because the " +
      "write's own block already carries the time and a counter cannot disagree with " +
      "it. This is the only key the agent's own key may write; revoking that one " +
      "permission stops the agent. Absent on a name whose agent has not yet booted.",
    pattern: "^beat-[0-9]+$",
    examples: ["beat-7"],
  },
};

/**
 * The keys a conforming capsule always carries.
 *
 * Everything except the heartbeat, which a freshly minted name has never
 * written — the same reasoning that keeps it out of `REQUIRED_TEXT_KEYS` in
 * records.ts. Requiring it here would make every capsule non-conforming for
 * the first minutes of its life, including during a demo.
 */
const REQUIRED = OWN_SCHEMA_KEYS.filter((key) => key !== HEARTBEAT_KEY);

/**
 * Builds the document.
 *
 * `$id` is the URI it was fetched from, which is the one part that cannot be a
 * constant: preview and production serve the same document from different
 * hosts, and a `$id` that disagrees with the fetch URL is a schema that fails
 * to resolve against itself.
 */
export function capsuleAgentSchema(id: string): Record<string, unknown> {
  return {
    $schema: SCHEMA_DIALECT,
    $id: id,
    // ENSIP-27 requires the schema's title to equal the `class` record it
    // describes. One constant, so the two records cannot drift apart.
    title: SCHEMA_TITLE,
    description:
      "Attributes of a Capsule agent — an AI agent whose ENS name is its identity, its " +
      "configuration and its kill switch. Describes only the keys no ENSIP defines. " +
      "`class`, `schema`, `agent-context` and `agent-endpoint[<protocol>]` are owned by " +
      "ENSIP-26 and ENSIP-27, `addr` by ENSIP-1/9, and `agent-registration[<registry>]" +
      "[<agentId>]` by ENSIP-25 — none are redeclared here.",
    type: "object",
    properties: ATTRIBUTES,
    required: REQUIRED,
    // True, and not by omission. A capsule name carries `class`, `schema`,
    // `addr` and three ENSIP-26 keys besides these four; sealing the object
    // would declare every real name invalid against its own schema.
    additionalProperties: true,
  };
}
