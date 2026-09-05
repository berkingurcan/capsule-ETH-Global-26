"use client";

import { useEffect, useRef, useState } from "react";
import Capsule from "@/components/Capsule";
import { ANSWERS, type Answer } from "@/lib/mock";

/* The fleet analyst: a Subgraph MCP server over both subgraphs, asked in
   plain language. The point of the track is the reasoning, not the rows —
   so every answer leads with a sentence and shows its query underneath. */

const QUERIES = [
  `{ records(where: { day: "today" }) {
    name  key  writer  txHash
} }`,
  `{ agents { name
    earned: transfersTo(currency: "USDC")
    spent:  transfersFrom(currency: "USDC")
} }`,
  `{ heartbeats(orderBy: time) { name  time }
   roleRevokes { name  time  by } }`,
];

type Turn = { who: "you" | "analyst"; text: string; answer?: Answer; query?: string };

export default function AnalystPage() {
  const [turns, setTurns] = useState<Turn[]>([
    {
      who: "analyst",
      text:
        "I read both subgraphs — names, roles and heartbeats on Sepolia, USDC on Base. Ask me about the fleet in plain language.",
    },
    { who: "you", text: ANSWERS[2].q },
    { who: "analyst", text: ANSWERS[2].a, answer: ANSWERS[2], query: QUERIES[2] },
  ]);
  const [thinking, setThinking] = useState(false);
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, thinking]);

  function ask(q: string, i?: number) {
    if (thinking || !q.trim()) return;
    const known = i !== undefined ? ANSWERS[i] : ANSWERS.find((a) => a.q.toLowerCase() === q.trim().toLowerCase());
    setTurns((t) => [...t, { who: "you", text: q }]);
    setDraft("");
    setThinking(true);

    setTimeout(() => {
      setThinking(false);
      if (known) {
        setTurns((t) => [
          ...t,
          { who: "analyst", text: known.a, answer: known, query: QUERIES[ANSWERS.indexOf(known)] },
        ]);
      } else {
        setTurns((t) => [
          ...t,
          {
            who: "analyst",
            text:
              "This demo only carries three worked answers. Try one of the questions on the left — those run against the real subgraph shape.",
          },
        ]);
      }
    }, 1400);
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
            A Subgraph MCP server sits over both subgraphs. It answers in sentences and shows the query it ran, so you
            can check it.
          </p>
        </div>

        <div className="grid g-side" style={{ gap: 26 }}>
          {/* transcript */}
          <div className="panel" style={{ overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 520 }}>
            <div className="row" style={{ padding: "14px 20px", background: "var(--ink)", color: "var(--vend-100)" }}>
              <Capsule size={20} cap="#FF4D8D" />
              <span className="label" style={{ color: "var(--vend-300)" }}>
                capsule-analyst
              </span>
              <span className="push mono" style={{ fontSize: 11, color: "var(--vend-300)" }}>
                2 subgraphs · MCP
              </span>
            </div>

            <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 18, flex: 1 }}>
              {turns.map((t, i) =>
                t.who === "you" ? (
                  <div key={i} style={{ alignSelf: "flex-end", maxWidth: "80%" }}>
                    <div
                      className="panel flat"
                      style={{ background: "var(--sun)", padding: "12px 16px", borderRadius: 16, fontSize: 15 }}
                    >
                      {t.text}
                    </div>
                  </div>
                ) : (
                  <div key={i} style={{ maxWidth: "92%" }}>
                    <div className="panel flat shell" style={{ padding: "16px 18px", borderRadius: 16 }}>
                      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>{t.text}</p>

                      {t.answer?.rows && (
                        <div className="stack" style={{ marginTop: 14 }}>
                          {t.answer.rows.map((r) => (
                            <div key={r.name} className="row" style={{ padding: "10px 0", gap: 12 }}>
                              <span className="ensname" style={{ fontSize: 13 }}>
                                {r.name}
                              </span>
                              <span className="push mono" style={{ fontSize: 13, fontWeight: 700 }}>
                                {r.value}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      {t.answer?.rows && (
                        <div className="col" style={{ gap: 4, marginTop: 8 }}>
                          {t.answer.rows.map((r) => (
                            <div key={r.name} className="hint mono" style={{ fontSize: 11 }}>
                              {r.name} — {r.note}
                            </div>
                          ))}
                        </div>
                      )}

                      {t.query && (
                        <details style={{ marginTop: 14 }}>
                          <summary className="label" style={{ cursor: "pointer" }}>
                            The query it ran
                          </summary>
                          <pre className="term" style={{ marginTop: 10, fontSize: 11.5 }}>
                            {t.query}
                          </pre>
                        </details>
                      )}

                      {t.answer && (
                        <div className="row" style={{ marginTop: 12 }}>
                          <span className="tag">{t.answer.source}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )
              )}

              {thinking && (
                <div className="row" style={{ gap: 10 }}>
                  <span className="pill wait">
                    <span className="led pulse" />
                    querying
                  </span>
                  <span className="hint mono" style={{ fontSize: 12 }}>
                    reading subgraph-sepolia, subgraph-base…
                  </span>
                </div>
              )}
              <div ref={end} />
            </div>

            <form
              className="row"
              style={{ padding: "14px 18px", borderTop: "3px solid var(--ink)", gap: 10, background: "var(--paper)" }}
              onSubmit={(e) => {
                e.preventDefault();
                ask(draft);
              }}
            >
              <input
                className="input"
                placeholder="Ask about the fleet…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label="Ask the analyst"
              />
              <button className="btn btn-primary" type="submit" disabled={thinking || !draft.trim()}>
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
                {ANSWERS.map((a, i) => (
                  <button
                    key={a.q}
                    className="pick"
                    style={{ padding: "14px 16px", fontSize: 14, lineHeight: 1.45 }}
                    onClick={() => ask(a.q, i)}
                    disabled={thinking}
                  >
                    {a.q}
                  </button>
                ))}
              </div>
            </div>

            <div className="notice paper">
              <span className="tag ink">Why</span>
              <p style={{ margin: 0 }}>
                Permission events and money events sit in the same story. That is what makes a question like “is any
                agent earning less than it spends?” answerable at all.
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
