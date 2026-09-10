/**
 * POST /api/analyst — the fleet, asked in plain language.
 *
 * Claude with one toolset: The Graph's Subgraph MCP server, pointed at the
 * fleet subgraph. The model reads the schema, writes GraphQL, runs it against
 * a live Graph provider, and answers from the rows that come back.
 *
 * ## Why this is an MCP connector and not a tool this file implements
 *
 * The obvious build is three custom tools — `get_schema`, `run_query`,
 * `list_capsules` — wrapping our own subgraph URL. It would work, and it would
 * be a worse demonstration of the thing being demonstrated. Subgraph MCP is a
 * standard interface to *any* subgraph on the network: the same server that
 * answers this route's questions answers them about Uniswap, and the reason
 * our fleet is reachable through it is that the subgraph publishes a schema in
 * the shape every other subgraph publishes one. Writing a bespoke wrapper
 * would hide exactly the property worth showing.
 *
 * It also means the connection is made server-side by Anthropic rather than by
 * a proxy we run: `mcp_servers` + an `mcp_toolset` on the same request. Two
 * halves, both required — a server with no toolset referencing it is rejected
 * as a validation error, not silently ignored.
 *
 * ## What this route will not do
 *
 * It will not answer without querying. The system prompt says so, and the
 * response says which tools ran, so an answer that arrives with no
 * `execute_query_*` behind it is visibly an answer the model made up. The page
 * renders the query alongside the sentence for the same reason: a natural
 * language interface over financial-adjacent data is only worth anything if
 * you can check it.
 *
 * The Graph API key never reaches the browser. It is sent to the Messages API
 * as the MCP server's `authorization_token` and nowhere else.
 */
import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { InvalidEnvError, MissingEnvError, loadAnalystEnv } from "@/lib/capsule/env";

/** Node, not edge: the Anthropic SDK and a long-lived stream want it. */
export const runtime = "nodejs";
/** An answer that queried a subgraph is never the same twice. */
export const dynamic = "force-dynamic";
/** Tool round trips through a hosted MCP server take longer than the default. */
export const maxDuration = 120;

/** The Graph's hosted Subgraph MCP server. */
const SUBGRAPH_MCP_URL = "https://subgraphs.mcp.thegraph.com/sse";
const SERVER_NAME = "subgraph";

/**
 * Deliberately not the streaming default of ~64000.
 *
 * The output here is a paragraph and, at most, a short table — the volume in
 * this conversation is tool *results* coming back in, not tokens going out.
 * `max_tokens` also has to cover adaptive thinking, so this is sized for "a
 * few tool round trips and a considered answer" rather than for prose.
 */
const MAX_TOKENS = 16000;

/** Anything longer is not a question about a fleet of four agents. */
const MAX_QUESTION = 500;
/** How much conversation to carry. Enough for a follow-up, not a transcript. */
const MAX_HISTORY = 12;

type Turn = { role: "user" | "assistant"; content: string };

type Body = {
  question?: unknown;
  history?: unknown;
};

/**
 * What the model is told before it sees the question.
 *
 * The domain half matters as much as the schema half. Without it the model
 * reads `authorized: false` as a permissions bug rather than as the product's
 * headline feature, and reports a capsule that stopped beating as a crash when
 * the whole point of this system is that a stopped capsule is usually someone
 * pulling a role on purpose.
 */
function systemPrompt(subgraphId: string): string {
  return `You are the fleet analyst for Capsule, reading a subgraph of AI agents that live as ENSv2 names on Ethereum Sepolia.

## What you are looking at

Every agent is one ENS subname, e.g. \`analyst.capsulefleet.eth\`, minted by a contract called CapsuleMinter under a parent name its owner connected. The name is not a label on the agent — it *is* the agent:

- Its configuration lives in the name's text records: \`agent-model\`, \`agent-prompt\` (a pointer such as \`cap_8f3d1a\`, never the prompt body), \`agent-runtime\`, \`agent-context\`, \`agent-endpoint[capsule]\`, \`agent-endpoint[web]\`.
- Its permissions live in ENSv2's PermissionedResolver, scoped per name AND per record key. The agent's own wallet may write exactly one key, \`agent-heartbeat\`, and nothing else — so an agent cannot rewrite its own instructions even if it is compromised.
- Its owner holds the admin role and can revoke that one key in a single transaction. That is the kill switch, and it is enforced by ENS rather than by any backend.

So three things are worth keeping straight, because they look alike and are not:

1. **Recalled** — \`authorized: false\`. The owner pulled the heartbeat role. The agent did not fail; it was stopped. Its subname, records and history all survive.
2. **Silent** — still authorized, but no recent heartbeat. The permission is intact and the machine is not running. That is an infrastructure problem, not an ENS one.
3. **Never booted** — minted, \`beatCount: 0\`. Nothing ever ran.

A heartbeat is an on-chain write of \`beat-<n>\`, a monotonic counter, costing about 47,639 gas paid by the agent's own wallet. There is no cadence on chain — it is configured in each runner's environment, so an interval is only ever observed, never declared. The demo runs at 60 seconds; the documented default is 28800.

## The subgraph

Query subgraph ID \`${subgraphId}\`. Always call \`get_schema_by_subgraph_id\` before your first query so you are writing GraphQL against the real schema rather than against this summary. The entities are:

- \`Parent\` — a connected ENS name. Fields include \`name\`, \`resolver\`, \`open\`, \`connected\`, \`capsuleCount\`, and \`capsules\`.
- \`Capsule\` — one agent. Current record values (\`model\`, \`prompt\`, \`context\`, \`runtime\`, \`endpointCapsule\`, \`endpointWeb\`, \`heartbeat\`), identity (\`name\`, \`label\`, \`owner\`, \`agent\`, \`addr\`, \`tokenId\`), permission (\`authorized\`, \`recallCount\`, \`recalledAt\`), heartbeat state (\`beatCount\`, \`firstBeatAt\`, \`lastBeatAt\`, \`lastInterval\`), and churn (\`configWriteCount\`, \`ownerWriteCount\`, \`lastConfigChangeAt\`).
- \`RecordWrite\` — one \`setText\`. \`key\`, \`value\`, \`writer\` (the address that signed it), \`byAgent\`, \`isHeartbeat\`, \`timestamp\`, \`tx\`.
- \`Heartbeat\` — one beat. \`sequence\`, \`value\`, \`interval\` (seconds since the previous beat, null for the first), \`timestamp\`.
- \`RoleChange\` — one permission change. \`granted\`, \`revoked\`, \`account\`, \`changedBy\`, \`resourceKind\` (\`agent-heartbeat\` or \`name\`), \`beatsAtChange\`, and \`secondsSinceLastBeat\` — the gap between the capsule's last heartbeat and this change.
- \`Fleet\` — totals across the whole deployment.

\`secondsSinceLastBeat\` on a RoleChange is the field to reach for when someone asks whether an agent stopped before or after it was recalled. It is a join across two contracts' event streams that no single contract emits together, and it is the reason this subgraph exists.

All timestamps are Unix seconds. Compare them to each other rather than to your own idea of the current time.

## How to answer

- Query first. Never answer a question about the fleet from this prompt alone — this prompt describes the shape of the data, not its contents.
- Lead with one sentence that answers the question. Then the specifics.
- Name names. \`analyst.capsulefleet.eth\`, not "one of the agents".
- Give numbers as they came back. Never round a count, never estimate a timestamp, never fill a gap with a plausible value.
- If the rows do not answer the question, say exactly that and say what they do show. A wrong confident answer about whether an agent is alive is worse than no answer.
- Distinguish "the fleet has never done this" from "I could not find it". An empty result set is a real answer and usually an interesting one.
- Keep it short. Two or three sentences plus figures, not an essay.`;
}

export async function POST(request: Request): Promise<Response> {
  let env;
  try {
    env = loadAnalystEnv();
  } catch (error) {
    if (error instanceof MissingEnvError || error instanceof InvalidEnvError) {
      // Named, because the two variables this needs are exactly the two a
      // fresh deployment has not set, and "the analyst is unavailable" would
      // send someone reading logs.
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "the request body is not JSON" }, { status: 400 });
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (question === "") {
    return NextResponse.json({ error: "ask a question" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION) {
    return NextResponse.json(
      { error: `the question is ${question.length} characters; the limit is ${MAX_QUESTION}` },
      { status: 400 },
    );
  }

  const history = parseHistory(body.history);

  const client = new Anthropic({ apiKey: env.anthropicApiKey });

  const stream = client.beta.messages.stream({
    model: "claude-opus-5",
    max_tokens: MAX_TOKENS,
    betas: ["mcp-client-2025-11-20", "server-side-fallback-2026-07-01"],
    // A safety refusal on "which agent stopped beating" is not a live risk,
    // but a refusal arrives as a 200 with no content and this route has no
    // second attempt in it. `"default"` routes by refusal category rather than
    // pinning a model list that would go stale.
    fallbacks: "default",
    system: systemPrompt(env.subgraphId),
    // Adaptive, and displayed. Working out which entity answers a question is
    // the interesting part of this route, and a page that shows the GraphQL
    // but hides the reasoning that chose it is showing the less useful half.
    thinking: { type: "adaptive", display: "summarized" },
    mcp_servers: [
      {
        type: "url",
        url: SUBGRAPH_MCP_URL,
        name: SERVER_NAME,
        // Server-side only. This is a Graph gateway key and it is never sent
        // to the browser, logged, or written into a response.
        authorization_token: env.graphApiKey,
      },
    ],
    // Required alongside `mcp_servers` — a server that no toolset references
    // is a validation error rather than an unused connection.
    tools: [{ type: "mcp_toolset", mcp_server_name: SERVER_NAME }],
    messages: [...history, { role: "user", content: question }],
  });

  const encoder = new TextEncoder();

  /**
   * Newline-delimited JSON, one event per line.
   *
   * Not SSE. The page consumes this with a plain `fetch` reader and needs no
   * `EventSource`, no reconnection semantics, and no `text/event-stream`
   * framing that Next's dev server would want to buffer.
   */
  const output = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      // MCP tool inputs arrive as `input_json_delta` fragments across many
      // events, keyed by content block index. They are accumulated here and
      // parsed once the block closes — never string-matched, because the
      // escaping in a partial JSON fragment is not the escaping in the value.
      const pending = new Map<number, { name: string; json: string }>();

      try {
        for await (const event of stream) {
          switch (event.type) {
            case "content_block_start": {
              const block = event.content_block as { type: string; name?: string };
              if (block.type === "mcp_tool_use") {
                pending.set(event.index, { name: block.name ?? "unknown", json: "" });
              } else if (block.type === "mcp_tool_result") {
                const result = event.content_block as { is_error?: boolean };
                send({ type: "tool_result", isError: result.is_error === true });
              }
              break;
            }
            case "content_block_delta": {
              if (event.delta.type === "text_delta") {
                send({ type: "text", text: event.delta.text });
              } else if (event.delta.type === "thinking_delta") {
                send({ type: "thinking", text: event.delta.thinking });
              } else if (event.delta.type === "input_json_delta") {
                const open = pending.get(event.index);
                if (open !== undefined) open.json += event.delta.partial_json;
              }
              break;
            }
            case "content_block_stop": {
              const open = pending.get(event.index);
              if (open !== undefined) {
                pending.delete(event.index);
                send({ type: "tool", name: open.name, input: safeParse(open.json) });
              }
              break;
            }
          }
        }

        const message = await stream.finalMessage();
        // Refusals arrive as a 200 with no useful content, so the page has to
        // be told rather than left rendering an empty bubble.
        if (message.stop_reason === "refusal") {
          send({ type: "error", message: "The model declined to answer that." });
        } else if (message.stop_reason === "max_tokens") {
          send({ type: "error", message: "The answer ran past its length limit — try a narrower question." });
        }
        send({ type: "done" });
      } catch (error) {
        // Anything past the first byte cannot become an HTTP status: the
        // response is already streaming. So a failure is an event, and the
        // page renders it as the analyst saying it could not answer.
        const message =
          error instanceof Anthropic.APIError
            ? `${error.status ?? ""} ${error.message}`.trim()
            : error instanceof Error
              ? error.message
              : "the analyst failed";
        send({ type: "error", message });
        send({ type: "done" });
      } finally {
        controller.close();
      }
    },
    cancel() {
      // The reader went away — a closed tab, a navigation. Stop paying for it.
      stream.abort();
    },
  });

  return new Response(output, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      // Proxies that buffer a stream turn "watch it think" into "wait, then
      // everything at once", which is the whole UX of this page.
      "x-accel-buffering": "no",
    },
  });
}

/** Tool inputs are JSON. A fragment that did not close is reported, not guessed at. */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return { unparsed: json };
  }
}

/**
 * Prior turns, trimmed and re-typed.
 *
 * Only text is carried back. Tool uses and their results are deliberately
 * dropped: replaying them would let a follow-up answer from a previous
 * query's rows, and the fleet moves between questions.
 */
function parseHistory(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  const turns: Turn[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || content.trim() === "") continue;
    turns.push({ role, content: content.slice(0, MAX_QUESTION * 4) });
  }
  // Keep the most recent turns, and start on a user turn — the Messages API
  // rejects a history that opens with an assistant reply to nothing.
  const tail = turns.slice(-MAX_HISTORY);
  while (tail.length > 0 && tail[0].role !== "user") tail.shift();
  return tail;
}
