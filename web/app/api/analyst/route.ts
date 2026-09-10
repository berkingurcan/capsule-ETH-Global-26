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
 * ## Two modes, and the lesser one is not a fallback for failure
 *
 * `loadAnalystEnv()` infers which door onto the subgraph is open. Published to
 * the decentralized network, and the model gets the MCP toolset above.
 * Deployed to Studio only — which is where every subgraph starts — and the
 * gateway cannot see it by any identifier, so the model gets two local
 * function tools against the Studio endpoint instead
 * (`lib/capsule/subgraph-tools.ts`).
 *
 * The model's job is identical either way: discover the schema, write GraphQL,
 * run it, answer from rows. Only the transport differs, and the switch is one
 * environment variable rather than a code change.
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
import { InvalidEnvError, MissingEnvError, loadAnalystEnv, type AnalystEnv } from "@/lib/capsule/env";
import {
  SUBGRAPH_FUNCTION_TOOLS,
  SUBGRAPH_TOOL_NAMES,
  runSubgraphTool,
} from "@/lib/capsule/subgraph-tools";
import { parentNameProblems } from "@/lib/capsule/parent";

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

/**
 * How many times the model may call a tool before it has to answer.
 *
 * Only reached in `direct` mode, where this route runs the loop; the MCP
 * server runs its own and returns once. Six is a schema read, a few queries
 * and a retry — past that the model is guessing at a schema it has already
 * been shown, and a runaway loop on a metered API is a bill rather than an
 * answer.
 *
 * Reaching this ceiling is not a failure. The turn after it is issued with
 * `tool_choice: "none"`, so the model answers from the rows it has instead of
 * asking for more — see the loop in `POST`. Four turns with no such exit was
 * the original shape, and it produced the worst possible outcome: every query
 * paid for, every row fetched, and an error where the sentence should be.
 */
const MAX_TOOL_TURNS = 6;

/** Anything longer is not a question about a fleet of four agents. */
const MAX_QUESTION = 500;
/** How much conversation to carry. Enough for a follow-up, not a transcript. */
const MAX_HISTORY = 12;

type Turn = { role: "user" | "assistant"; content: string };

type Body = {
  question?: unknown;
  history?: unknown;
  /**
   * Whose fleet the question is about, e.g. `testpriv.eth`.
   *
   * Supplied by the browser, which derives it from the connected wallet the
   * same way `/fleet` does — one minter serves every connected name, so "the
   * fleet" is not a thing that exists and a question about "my agents" is
   * meaningless without saying whose.
   *
   * Not a security boundary, and it must not be mistaken for one: everything
   * in the index is public and the model could read any parent if it chose to.
   * This is scoping, so that "which agents changed config today" answers about
   * the six the visitor owns rather than about every capsule the deployment has
   * ever minted.
   */
  parent?: unknown;
};

/**
 * Which tools to reach for, in the mode this deployment is actually in.
 *
 * Named tools rather than "use your tools": the MCP server exposes three
 * families that differ only in which identifier they take — by subgraph id, by
 * deployment id, by IPFS hash — and a model that picks the wrong one gets
 * "subgraph not found" and no hint about why. Being explicit costs a sentence.
 */
function toolGuidance(env: AnalystEnv): string {
  if (env.mode === "mcp") {
    return (
      `The subgraph is published to The Graph's decentralized network with subgraph ID \`${env.subgraphId}\`. ` +
      "Call `get_schema_by_subgraph_id` with that ID before your first query, then " +
      "`execute_query_by_subgraph_id` to run GraphQL against it. That ID is a *subgraph* ID — do not pass it to " +
      "the deployment-id or IPFS-hash variants of those tools."
    );
  }
  return (
    "Call `get_subgraph_schema` before your first query, then `run_subgraph_query` to run GraphQL against it. " +
    "Both address the fleet subgraph directly; neither takes an identifier."
  );
}

/**
 * Which fleet the question is about.
 *
 * Without this the model answers across every parent the minter has ever
 * served, which is the wrong answer to almost every question a visitor asks:
 * they mean *their* agents. With it, "which agents changed config today" is
 * scoped the same way the dashboard they just came from was.
 *
 * Spelled as a filter the model can paste rather than as a fact it has to
 * translate — `parent_` is graph-node's nested-entity filter and guessing it
 * costs a wasted query.
 */
function scopeGuidance(parent: string | null): string {
  if (parent === null) {
    return (
      "No particular fleet was named, so you are looking at every parent this deployment has served. " +
      "Say which parent each capsule belongs to, since more than one may appear."
    );
  }
  return (
    `The visitor is asking about the fleet under **${parent}**, and unless they clearly ask about ` +
    `something else you should scope every query to it: \`parents(where: { name: "${parent}" })\`, or ` +
    `\`capsules(where: { parent_: { name: "${parent}" } })\`, or on RecordWrite / Heartbeat / RoleChange ` +
    `\`where: { capsule_: { parent_: { name: "${parent}" } } }\`. If a query comes back empty, say so for ` +
    `that fleet rather than widening to every parent without saying you did.`
  );
}

/**
 * What the model is told before it sees the question.
 *
 * The domain half matters as much as the schema half. Without it the model
 * reads `authorized: false` as a permissions bug rather than as the product's
 * headline feature, and reports a capsule that stopped beating as a crash when
 * the whole point of this system is that a stopped capsule is usually someone
 * pulling a role on purpose.
 */
function instructions(env: AnalystEnv, parent: string | null): string {
  const tools = toolGuidance(env);
  const scope = scopeGuidance(parent);
  // The model has no clock, and this route's most common question — "which
  // agents changed config today" — is unanswerable without one. Left to work
  // it out, it spends two or three tool turns triangulating the date off
  // `_meta.block.timestamp` before it starts on the actual question, which is
  // how a four-turn budget gets exhausted on a query that needed one turn.
  // The server knows the time for free.
  const now = Math.floor(Date.now() / 1000);
  const midnight = Math.floor(now / 86400) * 86400;
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

${tools} The entities are:

- \`Parent\` — a connected ENS name. Fields include \`name\`, \`resolver\`, \`open\`, \`connected\`, \`capsuleCount\`, and \`capsules\`.
- \`Capsule\` — one agent. Current record values (\`model\`, \`prompt\`, \`context\`, \`runtime\`, \`endpointCapsule\`, \`endpointWeb\`, \`heartbeat\`), identity (\`name\`, \`label\`, \`owner\`, \`agent\`, \`addr\`, \`tokenId\`), permission (\`authorized\`, \`recallCount\`, \`recalledAt\`), heartbeat state (\`beatCount\`, \`firstBeatAt\`, \`lastBeatAt\`, \`lastInterval\`), and churn (\`configWriteCount\`, \`ownerWriteCount\`, \`lastConfigChangeAt\`).
- \`RecordWrite\` — one \`setText\`. \`key\`, \`value\`, \`writer\` (the address that signed it), \`byAgent\`, \`isHeartbeat\`, \`timestamp\`, \`tx\`.
- \`Heartbeat\` — one beat. \`sequence\`, \`value\`, \`interval\` (seconds since the previous beat, null for the first), \`timestamp\`.
- \`RoleChange\` — one permission change. \`granted\`, \`revoked\`, \`account\`, \`changedBy\`, \`resourceKind\` (\`agent-heartbeat\` or \`name\`), \`beatsAtChange\`, and \`secondsSinceLastBeat\` — the gap between the capsule's last heartbeat and this change.
- \`Fleet\` — totals across the whole deployment.

${scope}

\`secondsSinceLastBeat\` on a RoleChange is the field to reach for when someone asks whether an agent stopped before or after it was recalled. It is a join across two contracts' event streams that no single contract emits together, and it is the reason this subgraph exists.

## The time

All timestamps in the subgraph are Unix seconds.

- **Right now** is \`${now}\` — ${new Date(now * 1000).toISOString()}.
- **Today** means a timestamp at or after \`${midnight}\`, which is midnight UTC this morning. Yesterday is the 86400 seconds before that.

Use those two numbers directly. Do not spend a query working out the date from block timestamps, and do not fall back on your own idea of what year it is — the first wastes a turn you will want for the question, the second is wrong.

\`_meta { block { number timestamp } }\` is still worth asking for, but for a different reason: it says how far behind the chain the index is. If its timestamp is far from \`${now}\`, the index is lagging and recent events may be missing — say so.

## How to answer

- Query first. Never answer a question about the fleet from these instructions alone — they describe the shape of the data, not its contents.
- Read the schema before your first query, every time. This summary can drift from the deployed subgraph; the schema tool cannot.
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

  // A parent that fails validation is refused rather than dropped: silently
  // widening to every fleet would answer a question the visitor did not ask,
  // under a heading naming the one they did.
  let parent: string | null = null;
  if (typeof body.parent === "string" && body.parent.trim() !== "") {
    const candidate = body.parent.trim().toLowerCase();
    const problems = parentNameProblems(candidate);
    if (problems.length > 0) {
      return NextResponse.json({ error: `parent ${problems[0]}` }, { status: 400 });
    }
    parent = candidate;
  }

  const history = parseHistory(body.history);
  const client = new OpenAI({ apiKey: env.openaiApiKey });

  const tools: OpenAI.Responses.Tool[] =
    env.mode === "mcp"
      ? [
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
        ]
      : SUBGRAPH_FUNCTION_TOOLS;

  const prompt = instructions(env, parent);

  /**
   * The first request, made before the response starts streaming.
   *
   * Kept outside the ReadableStream so that a failure here is still an HTTP
   * status rather than an error event — this is where a bad key, an unknown
   * model or an unsupported parameter lands, and those deserve a status code.
   */
  type ResponseStream = AsyncIterable<OpenAI.Responses.ResponseStreamEvent> & {
    controller: AbortController;
  };

  /**
   * `answerOnly` is the exit ramp off the tool budget.
   *
   * The tools stay declared — the conversation carries `function_call` items
   * that would not validate against a request with none — and `tool_choice`
   * forbids reaching for them. So the last turn is spent on the sentence
   * rather than on a seventh query, and running out of budget degrades into a
   * narrower answer instead of no answer.
   */
  const open = (
    input: OpenAI.Responses.ResponseInput,
    previousResponseId?: string,
    answerOnly = false,
  ): Promise<ResponseStream> =>
    client.responses.create({
      model: MODEL,
      instructions: prompt,
      input,
      ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId }),
      max_output_tokens: MAX_OUTPUT_TOKENS,
      ...(REASONING_SUMMARY ? { reasoning: { summary: "auto" as const } } : {}),
      tools,
      ...(answerOnly ? { tool_choice: "none" as const } : {}),
      stream: true,
    }) as unknown as Promise<ResponseStream>;

  let stream: ResponseStream;
  try {
    stream = await open([...history, { role: "user" as const, content: question }]);
  } catch (error) {
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

      /**
       * Relay one model turn to the page, and report what it asked for.
       *
       * A function rather than the body of the loop because the last turn is
       * consumed outside it — once the tool budget is spent the model gets one
       * more turn with `tool_choice: "none"`, and that turn's text has to
       * reach the page the same way every other turn's does.
       */
      const consume = async (
        current: ResponseStream,
      ): Promise<{
        pending: { callId: string; name: string; arguments: string }[];
        responseId: string | undefined;
      }> => {
        const pending: { callId: string; name: string; arguments: string }[] = [];
        let responseId: string | undefined;

        for await (const event of current) {
          switch (event.type) {
            case "response.output_text.delta":
              send({ type: "text", text: event.delta });
              break;

            case "response.reasoning_summary_text.delta":
              send({ type: "thinking", text: event.delta });
              break;

            // A tool call is reported twice on purpose. `added` carries the
            // name and nothing else, which is what lets the page say
            // "running a query" while the arguments are still streaming;
            // `done` carries the finished arguments, which is the GraphQL
            // the answer has to be checkable against. The page upserts on
            // the id, so the second overwrites the first.
            case "response.output_item.added": {
              const item = event.item;
              if (item.type === "mcp_call") send({ type: "tool", id: item.id, name: item.name });
              else if (item.type === "function_call") send({ type: "tool", id: item.call_id, name: item.name });
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
              } else if (item.type === "function_call") {
                send({
                  type: "tool",
                  id: item.call_id,
                  name: item.name,
                  input: safeParse(item.arguments),
                });
                pending.push({ callId: item.call_id, name: item.name, arguments: item.arguments });
              }
              break;
            }

            case "response.mcp_call.failed":
              // The tool itself failed — a bad gateway key, a subgraph id
              // that does not resolve, a query the index rejected. The model
              // may still recover by trying something else, so this is
              // reported and not treated as the end of the answer.
              send({ type: "tool_failed" });
              break;

            case "response.completed":
              responseId = event.response.id;
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

        return { pending, responseId };
      };

      try {
        // One iteration in `mcp` mode — the MCP server runs its own tool loop
        // and the response comes back finished. In `direct` mode this is the
        // loop: stream a turn, execute whatever functions it asked for, hand
        // the results back, stream the next one.
        for (let turn = 0; ; turn += 1) {
          const { pending, responseId } = await consume(stream);

          if (pending.length === 0) break;

          // Every requested tool, in parallel — the model asks for a schema
          // read and a query together often enough to be worth it, and
          // `runSubgraphTool` never throws, so one failing does not lose the
          // others.
          const results = await Promise.all(
            pending.map(async (call) => ({
              type: "function_call_output" as const,
              call_id: call.callId,
              output: SUBGRAPH_TOOL_NAMES.has(call.name)
                ? await runSubgraphTool(call.name, call.arguments, env.subgraphUrl!)
                : `error: no tool named ${call.name}`,
            })),
          );

          // Out of budget, with results in hand. The turn that spends them is
          // issued with tools switched off rather than skipped: the rows have
          // already been fetched and paid for, and the model has one more
          // chance to turn them into a sentence. Erroring here instead — which
          // is what this did — threw away a complete answer at the last step
          // and showed a transcript of queries with nothing at the end of it.
          const lastTurn = turn >= MAX_TOOL_TURNS - 1;
          stream = await open(results, responseId, lastTurn);

          if (lastTurn) {
            await consume(stream);
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
