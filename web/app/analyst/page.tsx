"use client";

import { useEffect, useRef, useState } from "react";
import Capsule from "@/components/Capsule";

/* The fleet analyst.

   Claude, holding one toolset: The Graph's hosted Subgraph MCP server, pointed
   at the fleet subgraph. It reads the schema, writes GraphQL, runs it, and
   answers from the rows.

   Every answer shows the query that produced it. That is not a debugging
   affordance — it is the only thing that makes a natural-language interface
   over chain data worth trusting, and this page used to be scripted, which is
   exactly the failure it now guards against. If no `execute_query_*` appears
   under an answer, the answer came from nowhere and you can see that.

   The transcript starts empty. A page that opens with a worked example is a
   page that has decided what you were going to ask. */

const SUGGESTIONS = [
  "Which agents changed config today, and who authorised it?",
  "Show me anything that stopped heartbeating before it was recalled.",
  "What is every agent in the fleet running, and how often does each one beat?",
  "Has any agent ever had its heartbeat role pulled and then given back?",
];

type Tool = { name: string; input: unknown };

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

export default function AnalystPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);

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
        body: JSON.stringify({ question: asked, history }),
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
          let event: { type?: string; text?: string; name?: string; input?: unknown; message?: string };
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
          } else if (event.type === "tool" && event.name !== undefined) {
            const tool: Tool = { name: event.name, input: event.input };
            patch((turn) => {
              turn.tools = [...turn.tools, tool];
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
            Claude reads the fleet subgraph through The Graph&rsquo;s Subgraph MCP server — mints, record writes, role
            changes and heartbeats, in one index. It answers in sentences and shows the GraphQL it ran, so you can
            check it.
          </p>
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
                    I read the fleet subgraph — names, records, roles and heartbeats on ETH Sepolia. Ask me about the
                    fleet in plain language, or pick one of the questions on the right.
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
                          {turn.tools.map((tool, t) => (
                            <div key={t} className="hint mono" style={{ fontSize: 11 }}>
                              → {toolLabel(tool.name)}
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

                      {turn.tools.map((tool, t) => {
                        const query = queryOf(tool.input);
                        if (query === null) return null;
                        return (
                          <details key={`q${t}`} style={{ marginTop: 14 }}>
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
              <div className="label" style={{ marginBottom: 12 }}>
                Try one
              </div>
              <div className="col" style={{ gap: 10 }}>
                {SUGGESTIONS.map((question) => (
                  <button
                    key={question}
                    className="pick"
                    style={{ padding: "14px 16px", fontSize: 14, lineHeight: 1.45 }}
                    onClick={() => void ask(question)}
                    disabled={busy}
                  >
                    {question}
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
                <a href="/fleet">The fleet dashboard</a> reads the same subgraph. The analyst is not a second source of
                truth about the fleet — it is a second way to ask the first one.
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
