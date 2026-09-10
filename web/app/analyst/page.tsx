"use client";

import { useEffect, useRef, useState } from "react";
import Capsule from "@/components/Capsule";
import { useWallet } from "@/lib/wallet/WalletProvider";
import { DEFAULT_PARENT_NAME } from "@/lib/capsule/public-env";

/* The fleet analyst.

   GPT, holding one tool: The Graph's hosted Subgraph MCP server, pointed at
   the fleet subgraph. It reads the schema, writes GraphQL, runs it, and answers
   from the rows.

   Every answer shows the query that produced it. That is not a debugging
   affordance — it is the only thing that makes a natural-language interface
   over chain data worth trusting, and this page used to be scripted, which is
   exactly the failure it now guards against. If no `execute_query_*` appears
   under an answer, the answer came from nowhere and you can see that.

   The transcript starts empty. A page that opens with a worked example is a
   page that has decided what you were going to ask.

   Whose fleet is derived from the connected wallet, exactly as /fleet derives
   it — one minter serves every connected name, so "my agents" is meaningless
   until you say whose. Without that the analyst answers across every parent the
   deployment has ever served, which is almost never the question. */

/**
 * The questions the front door opens on.
 *
 * Chosen against one test: a question an `eth_call` could answer is a question
 * that does not need this page. Every one of these needs *history* — events
 * counted, ordered, joined across two contracts, or subtracted from each other
 * — which is the thing a contract cannot tell you about itself and an index
 * can. The first one is the sharpest: no contract emits a heartbeat and a role
 * change together, so "did it die, or was it stopped?" exists only as a join.
 *
 * `why` is rendered under each. Not decoration — a visitor who clicks these in
 * order should be able to say what the subgraph is *for* without being told,
 * and the naming of real fields is what makes the answer checkable against the
 * GraphQL that comes back.
 */
const SUGGESTIONS = [
  {
    question: "Did any agent go silent before it was recalled, or was each one still healthy when it was stopped?",
    why: "Joins a role change to the last heartbeat — two contracts, one field: secondsSinceLastBeat.",
  },
  {
    question: "Which agent has been reconfigured the most, and what changed on it?",
    why: "Counts every setText since the minter was deployed, then ranks by configWriteCount.",
  },
  {
    question: "How often does each agent actually beat, and which one is drifting from the others?",
    why: "No cadence is declared on chain. lastInterval is observed, beat to beat.",
  },
  {
    question: "Who signed each write on this fleet — the owner, or the agent itself?",
    why: "byAgent and writer, per record. The permission split, as it actually played out.",
  },
  {
    question: "Has anything been minted here and never booted?",
    why: "beatCount: 0. An empty answer is a real answer, and this is how you tell it from a failed lookup.",
  },
];

/**
 * One MCP tool call.
 *
 * `input` is optional because a call is announced before its arguments have
 * finished streaming: the route sends the name as soon as the model commits to
 * the call, then sends it again with the finished GraphQL. Keyed by `id` so the
 * second replaces the first rather than appending a duplicate row.
 */
type Tool = { id: string; name: string; input?: unknown; failed?: boolean };

type Turn =
  | { who: "you"; text: string }
  | {
      who: "analyst";
      text: string;
      thinking: string;
      tools: Tool[];
      queried: boolean;
      error: string | null;
      done: boolean;
    };

/** The GraphQL out of an `execute_query_*` input, or null for a schema read. */
function queryOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const query = (input as { query?: unknown }).query;
  return typeof query === "string" ? query : null;
}

/** What the analyst is doing right now, in three words. */
function toolLabel(name: string): string {
  if (name.startsWith("get_schema")) return "reading the schema";
  if (name.startsWith("execute_query")) return "running a query";
  if (name.startsWith("search_subgraphs")) return "finding the subgraph";
  return name.replace(/_/g, " ");
}

type OwnedParent = { name: string; open: boolean; minted: number; connectedByOwner: boolean };

export default function AnalystPage() {
  const { address } = useWallet();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [parents, setParents] = useState<OwnedParent[] | null>(null);
  // Seeded with the deployment's default rather than null, so the first paint
  // already names a fleet. Starting at null renders "every fleet this
  // deployment has minted" for the tick before the wallet effect runs, which is
  // a different claim about what the answers will cover.
  const [parent, setParent] = useState<string | null>(
    DEFAULT_PARENT_NAME === "" ? null : DEFAULT_PARENT_NAME,
  );
  const [finding, setFinding] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  /* Whose fleet, from the wallet — the same lookup FleetRouter does, against
     the same route, so the analyst and the dashboard can never disagree about
     which names belong to the visitor.

     A wallet with several names is a real choice and the app must not guess:
     the first is selected so the page is usable immediately, and the others are
     offered as buttons. A disconnected wallet falls back to the deployment's
     default, which is what a stranger should see. */
  useEffect(() => {
    if (address === null) {
      setParents(null);
      setParent(DEFAULT_PARENT_NAME === "" ? null : DEFAULT_PARENT_NAME);
      return;
    }
    let cancelled = false;
    setFinding(true);
    fetch(`/api/capsule/parents?owner=${address}`)
      .then((response) => (response.ok ? response.json() : { parents: [] }))
      .then((body: { parents?: OwnedParent[] }) => {
        if (cancelled) return;
        const found = body.parents ?? [];
        setParents(found);
        setParent(found[0]?.name ?? (DEFAULT_PARENT_NAME === "" ? null : DEFAULT_PARENT_NAME));
      })
      .catch(() => {
        // A failed lookup costs the scoping, not the page: the analyst still
        // answers, just across every fleet, and the header says so.
        if (!cancelled) setParents([]);
      })
      .finally(() => {
        if (!cancelled) setFinding(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  async function ask(question: string): Promise<void> {
    const asked = question.trim();
    if (busy || asked === "") return;

    // Only text goes back, and only completed turns. Replaying tool results
    // would let a follow-up answer from a previous query's rows, and the fleet
    // moves between questions.
    const history = turns
      .filter((turn) => turn.who === "you" || (turn.who === "analyst" && turn.error === null))
      .map((turn) => ({
        role: turn.who === "you" ? "user" : "assistant",
        content: turn.text,
      }))
      .filter((turn) => turn.content.trim() !== "");

    setTurns((current) => [
      ...current,
      { who: "you", text: asked },
      { who: "analyst", text: "", thinking: "", tools: [], queried: false, error: null, done: false },
    ]);
    setDraft("");
    setBusy(true);

    // Every update lands on the last turn, which is the analyst turn pushed
    // above. Keyed by position rather than by id because there is exactly one
    // in flight at a time — `busy` is what guarantees that.
    const patch = (change: (turn: Extract<Turn, { who: "analyst" }>) => void): void => {
      setTurns((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last === undefined || last.who !== "analyst") return current;
        const copy = { ...last };
        change(copy);
        next[next.length - 1] = copy;
        return next;
      });
    };

    try {
      const response = await fetch("/api/analyst", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: asked, history, parent }),
      });

      // A failure before the first byte is still an HTTP status, and the two
      // that matter say which variable a deployment has not set.
      if (!response.ok || response.body === null) {
        const detail = await response
          .json()
          .then((body: { error?: string }) => body.error)
          .catch(() => null);
        patch((turn) => {
          turn.error = detail ?? `the analyst answered ${response.status}`;
          turn.done = true;
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Newline-delimited JSON. The last fragment is usually a partial line
        // and is held back for the next chunk.
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.trim() === "") continue;
          let event: {
            type?: string;
            text?: string;
            id?: string;
            name?: string;
            input?: unknown;
            failed?: boolean;
            message?: string;
          };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === "text" && event.text !== undefined) {
            const text = event.text;
            patch((turn) => {
              turn.text += text;
            });
          } else if (event.type === "thinking" && event.text !== undefined) {
            const text = event.text;
            patch((turn) => {
              turn.thinking += text;
            });
          } else if (event.type === "tool" && event.id !== undefined && event.name !== undefined) {
            const tool: Tool = {
              id: event.id,
              name: event.name,
              input: event.input,
              failed: event.failed === true,
            };
            patch((turn) => {
              // Upsert. The same call arrives twice — once on announcement,
              // once with its finished arguments — and appending both would
              // print every query the analyst ran two times over.
              const at = turn.tools.findIndex((existing) => existing.id === tool.id);
              turn.tools = at === -1
                ? [...turn.tools, tool]
                : turn.tools.map((existing, i) => (i === at ? { ...existing, ...tool } : existing));
              if (tool.name.startsWith("execute_query")) turn.queried = true;
            });
          } else if (event.type === "error" && event.message !== undefined) {
            const message = event.message;
            patch((turn) => {
              turn.error = message;
            });
          }
        }
      }
      patch((turn) => {
        turn.done = true;
      });
    } catch (error) {
      patch((turn) => {
        turn.error = error instanceof Error ? error.message : "the connection dropped";
        turn.done = true;
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="wrap">
        <div style={{ marginBottom: 24 }}>
          <p className="kicker" style={{ margin: 0 }}>
            Fleet analyst
          </p>
          <h2 style={{ fontSize: 32, marginTop: 6 }}>Ask what the fleet did.</h2>
          <p className="hint" style={{ marginTop: 6, maxWidth: "68ch" }}>
            The model reads the fleet subgraph through The Graph&rsquo;s Subgraph MCP server — mints, record writes,
            role changes and heartbeats, in one index. It answers in sentences and shows the GraphQL it ran, so you
            can check it.
          </p>
          {/* Whose fleet, stated rather than assumed. The whole page is scoped
              to one parent and an answer about the wrong six agents looks
              exactly like an answer about the right six. */}
          <p className="hint mono" style={{ marginTop: 10, fontSize: 12 }}>
            {finding
              ? "checking which names this wallet has…"
              : parent === null
                ? "reading every fleet this deployment has minted"
                : `reading ${parent}${address === null ? " (the default — connect a wallet for yours)" : ""}`}
          </p>

          {/* Two or more names is a genuine choice and the app must not guess,
              the same rule /fleet follows. Switching clears the transcript:
              a follow-up carries prior turns, and answers about one fleet are
              not context for a question about another. */}
          {(parents ?? []).length > 1 && (
            <div className="row wrapflex" style={{ gap: 8, marginTop: 10 }}>
              {(parents ?? []).map((owned) => (
                <button
                  key={owned.name}
                  className={owned.name === parent ? "btn btn-sm btn-primary" : "btn btn-sm"}
                  disabled={busy}
                  onClick={() => {
                    if (owned.name === parent) return;
                    setParent(owned.name);
                    setTurns([]);
                  }}
                >
                  {owned.name}
                  <span className="hint" style={{ marginLeft: 8 }}>
                    {owned.minted > 0 ? `${owned.minted} agent${owned.minted === 1 ? "" : "s"}` : "no agents yet"}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="notice paper" style={{ marginTop: 16 }}>
            <span className="tag ink">Why a subgraph</span>
            <p style={{ margin: 0 }}>
              Mints come off <code>CapsuleMinter</code>; record writes and role changes come off each owner&rsquo;s{" "}
              <code>PermissionedResolver</code>. Nothing emits both. &ldquo;Did anything stop beating before it was
              recalled?&rdquo; is a join across two contracts on two different cadences — which is a field in the
              index and a program everywhere else.
            </p>
          </div>
        </div>

        <div className="grid g-side" style={{ gap: 26 }}>
          {/* transcript */}
          <div
            className="panel"
            style={{ overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 520 }}
          >
            <div className="row" style={{ padding: "14px 20px", background: "var(--ink)", color: "var(--vend-100)" }}>
              <Capsule size={20} cap="#FF4D8D" />
              <span className="label" style={{ color: "var(--vend-300)" }}>
                capsule-analyst
              </span>
              <span className="push mono" style={{ fontSize: 11, color: "var(--vend-300)" }}>
                subgraph · MCP
              </span>
            </div>

            <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 18, flex: 1 }}>
              {turns.length === 0 && (
                <div className="panel flat shell" style={{ padding: "16px 18px", borderRadius: 16 }}>
                  <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
                    I read the fleet subgraph — names, records, roles and heartbeats on ETH Sepolia.{" "}
                    {parent === null
                      ? "No fleet is selected, so I will answer across every name this deployment has minted."
                      : `Questions are scoped to ${parent}.`}{" "}
                    Ask in plain language, or pick one of the questions on the right.
                  </p>
                </div>
              )}

              {turns.map((turn, i) =>
                turn.who === "you" ? (
                  <div key={i} style={{ alignSelf: "flex-end", maxWidth: "80%" }}>
                    <div
                      className="panel flat"
                      style={{ background: "var(--sun)", padding: "12px 16px", borderRadius: 16, fontSize: 15 }}
                    >
                      {turn.text}
                    </div>
                  </div>
                ) : (
                  <div key={i} style={{ maxWidth: "92%" }}>
                    <div className="panel flat shell" style={{ padding: "16px 18px", borderRadius: 16 }}>
                      {/* What it is doing, while it is doing it. The tools are
                          the honest progress bar: a spinner tells you to wait,
                          "running a query" tells you what for. */}
                      {turn.tools.length > 0 && (
                        <div className="col" style={{ gap: 4, marginBottom: turn.text === "" ? 0 : 12 }}>
                          {turn.tools.map((tool) => (
                            <div key={tool.id} className="hint mono" style={{ fontSize: 11 }}>
                              → {toolLabel(tool.name)}
                              {tool.failed === true ? " — failed" : ""}
                            </div>
                          ))}
                        </div>
                      )}

                      {turn.text === "" && !turn.done && turn.error === null && (
                        <div className="row" style={{ gap: 10 }}>
                          <span className="pill wait">
                            <span className="led pulse" />
                            {turn.tools.length === 0 ? "thinking" : "querying"}
                          </span>
                          {turn.thinking !== "" && (
                            <span className="hint mono" style={{ fontSize: 11 }}>
                              {turn.thinking.slice(-90)}
                            </span>
                          )}
                        </div>
                      )}

                      {turn.text !== "" && (
                        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{turn.text}</p>
                      )}

                      {turn.error !== null && (
                        <div className="notice" style={{ marginTop: turn.text === "" ? 0 : 12, borderColor: "#E03131" }}>
                          <span className="tag ink">Failed</span>
                          <p style={{ margin: 0 }}>{turn.error}</p>
                        </div>
                      )}

                      {turn.thinking !== "" && turn.text !== "" && (
                        <details style={{ marginTop: 14 }}>
                          <summary className="label" style={{ cursor: "pointer" }}>
                            How it got there
                          </summary>
                          <p className="hint" style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 13 }}>
                            {turn.thinking}
                          </p>
                        </details>
                      )}

                      {turn.tools.map((tool) => {
                        const query = queryOf(tool.input);
                        if (query === null) return null;
                        return (
                          <details key={`q${tool.id}`} style={{ marginTop: 14 }}>
                            <summary className="label" style={{ cursor: "pointer" }}>
                              The query it ran
                            </summary>
                            <pre className="term" style={{ marginTop: 10, fontSize: 11.5, overflowX: "auto" }}>
                              {query}
                            </pre>
                          </details>
                        );
                      })}

                      {turn.done && turn.error === null && (
                        <div className="row" style={{ marginTop: 12 }}>
                          <span className="tag">
                            {turn.queried ? "subgraph-sepolia · Subgraph MCP" : "answered without querying"}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )}
              <div ref={end} />
            </div>

            <form
              className="row"
              style={{ padding: "14px 18px", borderTop: "3px solid var(--ink)", gap: 10, background: "var(--paper)" }}
              onSubmit={(e) => {
                e.preventDefault();
                void ask(draft);
              }}
            >
              <input
                className="input"
                placeholder="Ask about the fleet…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label="Ask the analyst"
                maxLength={500}
              />
              <button className="btn btn-primary" type="submit" disabled={busy || draft.trim() === ""}>
                Ask
              </button>
            </form>
          </div>

          {/* suggestions */}
          <div className="col" style={{ gap: 18 }}>
            <div className="panel pad">
              <div className="label" style={{ marginBottom: 4 }}>
                Try one
              </div>
              <p className="hint" style={{ margin: "0 0 14px" }}>
                Each of these needs history, not state — the part a contract cannot answer about itself.
              </p>
              <div className="col" style={{ gap: 10 }}>
                {SUGGESTIONS.map(({ question, why }) => (
                  <button
                    key={question}
                    className="pick"
                    style={{ padding: "14px 16px", fontSize: 14, lineHeight: 1.45, gap: 7 }}
                    onClick={() => void ask(question)}
                    disabled={busy}
                  >
                    <span>{question}</span>
                    <span className="hint" style={{ fontSize: 12 }}>
                      {why}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="notice paper">
              <span className="tag ink">Check the work</span>
              <p style={{ margin: 0 }}>
                Every answer carries the GraphQL that produced it. An answer with no query under it did not read the
                chain, and the tag under it says so.
              </p>
            </div>

            <div className="notice paper">
              <span className="tag ink">Same index</span>
              <p style={{ margin: 0 }}>
                <a href={parent === null ? "/fleet" : `/fleet?parent=${encodeURIComponent(parent)}`}>
                  The fleet dashboard
                </a>{" "}
                reads the same subgraph, scoped to the same name. The analyst is not a second source of truth about
                the fleet — it is a second way to ask the first one.
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
