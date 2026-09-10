/**
 * The analyst's tools when the subgraph is not on the decentralized network.
 *
 * ## Why this exists
 *
 * The Graph's hosted Subgraph MCP server queries `gateway.thegraph.com`, and
 * the gateway only serves subgraphs **published** to the network. A subgraph
 * deployed to Subgraph Studio and not yet published is unreachable by every
 * identifier the MCP server accepts — measured, not assumed:
 *
 *   gateway /deployments/id/Qm…   ->  "subgraph not found"
 *   gateway /subgraphs/id/Qm…     ->  "invalid subgraph ID"
 *   Studio query URL              ->  200, real rows
 *
 * So these two functions are the same two capabilities the MCP server exposes —
 * read the schema, run a query — pointed at the Studio endpoint instead. The
 * model's job does not change: it still discovers the schema at runtime rather
 * than being handed one, and it still has to show the GraphQL it ran.
 *
 * This is the lesser path and it is meant to be temporary. Publishing the
 * subgraph makes `SUBGRAPH_ID` a network id, and `route.ts` switches back to
 * the MCP server on its own with no other change. The difference that matters
 * is not the transport — it is that Subgraph MCP is a standard interface to
 * *any* subgraph on the network, and this is a bespoke door onto exactly one.
 */

/** Truncation ceiling for a tool result. A fleet query is small; a mistake is not. */
const MAX_RESULT_CHARS = 24_000;

/** A GraphQL endpoint that hangs must not hold the whole answer open. */
const QUERY_TIMEOUT_MS = 15_000;

/**
 * The two tools, in the Responses API's function-tool shape.
 *
 * `strict: true` on the query tool because its one required argument is a
 * GraphQL document, and a call that arrives without it costs a whole model
 * turn to discover. The schema tool takes nothing at all.
 */
export const SUBGRAPH_FUNCTION_TOOLS = [
  {
    type: "function" as const,
    name: "get_subgraph_schema",
    description:
      "Return the GraphQL schema of the Capsule fleet subgraph: every entity type, its fields, " +
      "and the root query fields. Call this before writing any query.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    type: "function" as const,
    name: "run_subgraph_query",
    description:
      "Run a GraphQL query against the Capsule fleet subgraph and return the JSON response. " +
      "Standard graph-node arguments are available on every collection field: `where`, `orderBy`, " +
      "`orderDirection` (asc/desc), `first`, `skip`. Filter suffixes include `_gt`, `_gte`, `_lt`, " +
      "`_lte`, `_in`, `_not`, `_contains` and `_contains_nocase`. `_meta { block { number } }` gives " +
      "the block the index has reached.",
    // No `variables` argument, and that is a constraint rather than an
    // omission: `strict: true` requires `additionalProperties: false` on every
    // nested object, which makes an arbitrary key/value bag inexpressible.
    // GraphQL variables buy nothing here — nothing is reusing these documents —
    // so the query carries its own literals and the schema stays strict.
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The GraphQL query document, with any values inlined as literals.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export const SUBGRAPH_TOOL_NAMES = new Set(SUBGRAPH_FUNCTION_TOOLS.map((tool) => tool.name));

/**
 * Execute one tool call and return what the model should see.
 *
 * Always returns a string, never throws. A tool that throws would end the run;
 * a tool that reports its failure lets the model try something else, which for
 * a malformed query is usually the right outcome — and for a genuinely
 * unreachable subgraph produces an answer that says so.
 */
export async function runSubgraphTool(name: string, rawArguments: string, url: string): Promise<string> {
  let args: { query?: unknown };
  try {
    args = JSON.parse(rawArguments) as typeof args;
  } catch {
    return `error: the arguments were not valid JSON: ${rawArguments.slice(0, 200)}`;
  }

  if (name === "get_subgraph_schema") {
    return describeSchema(url);
  }
  if (name === "run_subgraph_query") {
    if (typeof args.query !== "string" || args.query.trim() === "") {
      return "error: `query` must be a non-empty GraphQL document";
    }
    return postQuery(url, args.query);
  }
  return `error: no tool named ${name}`;
}

async function postQuery(url: string, query: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) return `error: the subgraph answered ${response.status}: ${text.slice(0, 500)}`;
    return text.length > MAX_RESULT_CHARS
      ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated at ${MAX_RESULT_CHARS} characters — narrow the query with \`first\` or fewer fields]`
      : text;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return "error: the subgraph did not answer within 15 seconds";
    }
    return `error: ${error instanceof Error ? error.message : "the subgraph query failed"}`;
  } finally {
    clearTimeout(timer);
  }
}

////////////////////////////////////////////////////////////////////////////
// Schema introspection
////////////////////////////////////////////////////////////////////////////

type IntrospectedType = {
  name: string;
  kind: string;
  fields: { name: string; type: TypeRef }[] | null;
};

type TypeRef = { kind: string; name: string | null; ofType: TypeRef | null };

/**
 * Only what a query author needs.
 *
 * A full introspection of a graph-node schema is enormous and mostly noise:
 * one `*_filter` input type and one `*_orderBy` enum per entity, each carrying
 * a member per field per comparison suffix. Those are conventions rather than
 * discoveries, so they are described once in `run_subgraph_query`'s tool
 * description and left out of here — which keeps the schema this returns to a
 * few kilobytes of the part that is actually specific to this subgraph.
 */
const INTROSPECTION = `{
  __schema {
    queryType { name }
    types {
      name
      kind
      fields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
    }
  }
}`;

export async function describeSchema(url: string): Promise<string> {
  const raw = await postQuery(url, INTROSPECTION);
  let payload: {
    data?: { __schema?: { queryType: { name: string }; types: IntrospectedType[] } };
    errors?: { message: string }[];
  };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    return `error: could not read the schema — ${raw.slice(0, 400)}`;
  }
  if (payload.errors !== undefined && payload.errors.length > 0) {
    return `error: introspection failed — ${payload.errors.map((e) => e.message).join("; ")}`;
  }
  const schema = payload.data?.__schema;
  if (schema === undefined) return `error: the endpoint returned no schema — ${raw.slice(0, 400)}`;

  const lines: string[] = [];
  const queryTypeName = schema.queryType.name;

  const root = schema.types.find((type) => type.name === queryTypeName);
  if (root?.fields != null) {
    lines.push("# Root query fields");
    lines.push(
      root.fields
        .map((field) => field.name)
        .filter((name) => !name.startsWith("__"))
        .join(", "),
    );
    lines.push("");
  }

  lines.push("# Entities");
  for (const type of schema.types) {
    if (type.kind !== "OBJECT") continue;
    if (type.name.startsWith("__")) continue;
    if (type.name === queryTypeName || type.name === "Subscription") continue;
    if (type.fields == null) continue;
    lines.push(`type ${type.name} {`);
    for (const field of type.fields) {
      lines.push(`  ${field.name}: ${renderType(field.type)}`);
    }
    lines.push("}");
  }
  return lines.join("\n");
}

/** `{NON_NULL -> {LIST -> {NON_NULL -> Capsule}}}` -> `[Capsule!]!` */
function renderType(type: TypeRef): string {
  if (type.kind === "NON_NULL" && type.ofType !== null) return `${renderType(type.ofType)}!`;
  if (type.kind === "LIST" && type.ofType !== null) return `[${renderType(type.ofType)}]`;
  return type.name ?? "Unknown";
}
