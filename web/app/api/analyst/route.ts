/**
 * POST /api/analyst — the fleet, asked in plain language.
 *
 * GPT with one tool: The Graph's Subgraph MCP server, pointed at the fleet
 * subgraph. The model reads the schema, writes GraphQL, runs it against a live
 * Graph provider, and answers from the rows that come back.
 *
 * ## Why this is a hosted MCP tool and not three tools this file implements
 *
 * The obvious build is three custom functions — `get_schema`, `run_query`,
 * `list_capsules` — wrapping our own subgraph URL. It would work, and it would
 * be a worse demonstration of the thing being demonstrated. Subgraph MCP is a
 * standard interface to *any* subgraph on the network: the same server that
 * answers this route's questions answers them about Uniswap, and the reason
 * our fleet is reachable through it is that the subgraph publishes a schema in
 * the shape every other subgraph publishes one. A bespoke wrapper would hide
 * exactly the property worth showing.
 *
 * It also means OpenAI opens the MCP connection server-side. There is no
 * `mcp-remote` proxy to run, and the Graph gateway key is sent to the
 * Responses API as a request header and nowhere else — never to the browser,
 * never into a log line, never into the response body.
 *
 * ## `require_approval: "never"` is load-bearing
 *
 * The Responses API defaults to pausing the stream on an `mcp_approval_request`
 * and waiting for the caller to send an `mcp_approval_response`. This route
 * has no second turn in it, so the default would hang every question until the
 * request timed out. Skipping approvals is safe here for a specific reason and
 * not as a general habit: every tool this server exposes is a read, the
 * subgraph it reads is ours, and the key it authenticates with can do nothing
 * but query.
 *
 * ## What this route will not do
 *
 * It will not answer without querying. The system prompt says so, and the
 * response says which tools ran, so an answer that arrives with no
 * `execute_query_*` behind it is visibly an answer the model made up. The page
 * renders the GraphQL alongside the sentence for the same reason: a natural
 * language interface over chain data is only worth anything if you can check
 * it.
 */
import OpenAI from "openai";
import { NextResponse } from "next/server";
import { InvalidEnvError, MissingEnvError, loadAnalystEnv } from "@/lib/capsule/env";

/** Node, not edge: the OpenAI SDK and a long-lived stream want it. */
export const runtime = "nodejs";
/** An answer that queried a subgraph is never the same twice. */
export const dynamic = "force-dynamic";
/** Tool round trips through a hosted MCP server take longer than the default. */
export const maxDuration = 120;

/**
 * The model.
 *
 * Named here rather than in the environment because it is not a deployment
 * setting: this route's system prompt, its tool budget and its "answer in two
 * sentences" instruction are all written for a reasoning model that can plan a
 * couple of GraphQL queries. Swapping the model is a code change, and should
 * come with a look at the prompt.
 *
 * Not to be confused with `agent-model` on a capsule's ENS name, which is the
 * model that *capsule* runs and is read off the chain per agent.
 */
const MODEL = "gpt-5.6-luna";

/**
 * Ask for reasoning summaries, so the page can show its working.
 *
 * The one parameter here whose support on this model has not been verified
 * against a live call. If the API rejects it, the request 400s with a message
 * naming `reasoning` and the page prints it — set this to false and the route
 * works with no other change, losing only the "How it got there" panel.
 */
const REASONING_SUMMARY = true;

/** The Graph's hosted Subgraph MCP server. */
const SUBGRAPH_MCP_URL = "https://subgraphs.mcp.thegraph.com/sse";
const SERVER_LABEL = "subgraph";

/**
 * Deliberately not a large ceiling.
 *
 * The output here is a paragraph and, at most, a short table — the volume in
 * this conversation is tool *results* coming back in, not tokens going out.
 * On a reasoning model this also has to cover the reasoning, so it is sized
 * for "a few tool round trips and a considered answer" rather than for prose.
 */
const MAX_OUTPUT_TOKENS = 16000;

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
function instructions(subgraphId: string): string {
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

- Query first. Never answer a question about the fleet from these instructions alone — they describe the shape of the data, not its contents.
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
      // Named, because the three variables this needs are exactly the three a
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
  const client = new OpenAI({ apiKey: env.openaiApiKey });

  let stream;
  try {
    stream = await client.responses.create({
      model: MODEL,
      instructions: instructions(env.subgraphId),
      input: [...history, { role: "user" as const, content: question }],
      max_output_tokens: MAX_OUTPUT_TOKENS,
      ...(REASONING_SUMMARY ? { reasoning: { summary: "auto" as const } } : {}),
      tools: [
        {
          type: "mcp",
          server_label: SERVER_LABEL,
          server_description: "The Graph's Subgraph MCP server — schemas and GraphQL over indexed chain data.",
          server_url: SUBGRAPH_MCP_URL,
          // The gateway key, as the exact header The Graph documents:
          // `Authorization: Bearer <key>`. Sent through `headers` rather than
          // through the tool's `authorization` field because that field is
          // specified as an OAuth access token — this is an API key that
          // happens to travel as a bearer token, and spelling the header out
          // leaves nothing for the two to disagree about.
          headers: { Authorization: `Bearer ${env.graphApiKey}` },
          // See the note at the top of this file. Without it the stream stops
          // on the first tool call and waits for a turn this route never takes.
          require_approval: "never",
        },
      ],
      stream: true,
    });
  } catch (error) {
    // A failure here is before the first byte, so it can still be a status —
    // which is worth keeping, because this is where a bad key, an unknown
    // model or an unsupported parameter lands.
    const status = error instanceof OpenAI.APIError ? (error.status ?? 502) : 502;
    const message = error instanceof Error ? error.message : "the analyst could not start";
    return NextResponse.json({ error: message }, { status });
  }

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

      try {
        for await (const event of stream) {
          switch (event.type) {
            case "response.output_text.delta":
              send({ type: "text", text: event.delta });
              break;

            case "response.reasoning_summary_text.delta":
              send({ type: "thinking", text: event.delta });
              break;

            // A tool call appears twice on purpose. `added` carries the name
            // and nothing else, which is what makes the page able to say
            // "running a query" while the arguments are still streaming;
            // `done` carries the finished arguments, which is the GraphQL the
            // answer has to be checkable against. The page upserts on
            // `item.id`, so the second overwrites the first.
            case "response.output_item.added": {
              const item = event.item;
              if (item.type === "mcp_call") {
                send({ type: "tool", id: item.id, name: item.name });
              }
              break;
            }

            case "response.output_item.done": {
              const item = event.item;
              if (item.type === "mcp_call") {
                send({
                  type: "tool",
                  id: item.id,
                  name: item.name,
                  input: safeParse(item.arguments),
                  failed: item.error !== null && item.error !== undefined,
                });
              }
              break;
            }

            case "response.mcp_call.failed":
              // The tool itself failed — a bad gateway key, a subgraph id that
              // does not resolve, a query the index rejected. The model may
              // still recover by trying something else, so this is reported
              // and not treated as the end of the answer.
              send({ type: "tool_failed" });
              break;

            case "response.failed": {
              const detail = event.response.error;
              send({ type: "error", message: detail?.message ?? "the model run failed" });
              break;
            }

            case "response.incomplete": {
              const reason = event.response.incomplete_details?.reason;
              send({
                type: "error",
                message:
                  reason === "max_output_tokens"
                    ? "The answer ran past its length limit — try a narrower question."
                    : `The run stopped early (${reason ?? "unknown reason"}).`,
              });
              break;
            }

            case "error":
              send({ type: "error", message: event.message ?? "the stream errored" });
              break;
          }
        }
        send({ type: "done" });
      } catch (error) {
        // Anything past the first byte cannot become an HTTP status: the
        // response is already streaming. So a failure is an event, and the
        // page renders it as the analyst saying it could not answer.
        const message =
          error instanceof OpenAI.APIError
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
      stream.controller.abort();
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

/** Tool arguments are a JSON string. A fragment that did not close is reported, not guessed at. */
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
 * Only text is carried back. Tool calls and their results are deliberately
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
  // Keep the most recent turns, and start on a user turn — a history that
  // opens with an assistant reply to nothing is not a conversation.
  const tail = turns.slice(-MAX_HISTORY);
  while (tail.length > 0 && tail[0].role !== "user") tail.shift();
  return tail;
}
