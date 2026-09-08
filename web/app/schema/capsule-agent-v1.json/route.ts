/**
 * GET /schema/capsule-agent-v1.json — the ENSIP-27 schema every capsule points at.
 *
 * ENSIP-27 says a node may carry a `schema` record naming a JSON Schema that describes
 * whatever metadata attributes it holds beyond the ones ENS already defines. Every name
 * `CapsuleMinter` mints carries this URL, so this file is the difference between a client
 * reading `agent-model` as an opaque string and reading it as a documented field.
 *
 * Served as a route rather than a static file so the URL stays stable and cacheable
 * independently of the deployment's asset hashing. It must not change meaning once names
 * point at it: a schema is a promise made on chain, and every capsule ever minted by this
 * deployment references this exact path. New fields get a v2 and a new `SCHEMA_PATH`.
 *
 * Constraints ENSIP-27 actually imposes, all of which this satisfies:
 *
 *   - a flat, single-level object; every property is a string
 *   - property names in kebab-case
 *   - every property carries a description
 *   - no allOf / anyOf / oneOf
 *   - nothing here redefines a key ENSIP-5, ENSIP-26 or ENSIP-27 already owns, which is
 *     why `agent-context`, `agent-endpoint[…]`, `class` and `schema` are absent
 */
import { NextResponse } from "next/server";
import {
  KEY_HEARTBEAT,
  KEY_MODEL,
  KEY_PROMPT,
  KEY_RUNTIME,
  RUNTIME_OPENCLAW,
} from "@/lib/capsule/records";

/** Pure and constant. The one response in this app that should be cached hard. */
export const dynamic = "force-static";

const SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://capsule.dev/schema/capsule-agent-v1.json",
  title: "Capsule agent",
  description:
    "Metadata attributes carried by an ENS name minted as a Capsule agent. Read alongside " +
    "the ENSIP-26 agent records and the ENSIP-25 registration key, which this schema does " +
    "not restate. Every attribute is an ENSIP-5 text record.",
  type: "object",
  properties: {
    [KEY_MODEL]: {
      type: "string",
      recordType: "text",
      description:
        "The model the agent runs on, as a bare model id (claude-opus-5) or a " +
        "provider-qualified reference (anthropic/claude-opus-5). Changing this record " +
        "reconfigures and restarts the running agent; it is not a redeploy.",
    },
    [KEY_RUNTIME]: {
      type: "string",
      recordType: "text",
      description:
        `The runtime that supervises the agent process. "${RUNTIME_OPENCLAW}" is the only ` +
        "value Capsule ships. A runner refuses to boot a name naming a runtime it cannot " +
        "supervise rather than substituting its own.",
    },
    [KEY_PROMPT]: {
      type: "string",
      recordType: "text",
      description:
        "An opaque pointer to the agent's instructions, such as cap_8f3d1a. Never the " +
        "instructions themselves: the body is held encrypted off chain and released only " +
        "to a caller that signs as the address in this name's addr record. Possession of " +
        "the pointer grants nothing.",
    },
    [KEY_HEARTBEAT]: {
      type: "string",
      recordType: "text",
      description:
        "The agent's liveness signal, written by the agent itself, of the form beat-<n>. " +
        "This is the only record the agent's own key may write, enforced per key by the " +
        "resolver's access control rather than by any service. Revoking that one grant " +
        "stops the agent: its next write is refused and it shuts itself down.",
    },
  },
  required: [KEY_MODEL, KEY_PROMPT],
  additionalProperties: false,
} as const;

export function GET(): NextResponse {
  return NextResponse.json(SCHEMA, {
    headers: {
      "content-type": "application/schema+json",
      // Immutable by contract: names on chain point here, and a schema that changes
      // under them is worse than one that 404s, because nothing would notice.
      "cache-control": "public, max-age=3600, s-maxage=86400, immutable",
    },
  });
}
