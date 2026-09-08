"use client";

import { useState } from "react";
import Link from "next/link";
import Capsule from "./Capsule";
import StatusPill from "./StatusPill";
import Heartbeat from "./Heartbeat";
import Sparkline from "./Sparkline";
import LogStream from "./LogStream";
import RecallDialog from "./RecallDialog";
import ChainTag from "./ChainTag";
import { fullName, type Agent } from "@/lib/mock";
import {
  KEY_CONTEXT,
  KEY_ENDPOINT_CAPSULE,
  KEY_ENDPOINT_WEB,
  KEY_HEARTBEAT,
  KEY_MODEL,
  KEY_PROMPT,
  KEY_RUNTIME,
  KEY_SCHEMA,
  SCHEMA_PATH,
  WRITER,
} from "@/lib/capsule/records";

type Row = { key: string; value: string; writer: "owner" | "agent"; editable?: boolean };

export default function AgentDetail({ agent }: { agent: Agent }) {
  const [dead, setDead] = useState(agent.status === "recalled");
  const [dialog, setDialog] = useState(false);
  const [prompt, setPrompt] = useState(agent.prompt);
  const [editing, setEditing] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const status = dead ? ("recalled" as const) : agent.status;
  const name = fullName(agent);

  // `writer` is not this component's opinion. CapsuleMinter grants the owner name-wide
  // resolver roles and grants the agent ROLE_SET_TEXT on exactly one key, so WRITER is a
  // readout of the EAC grants — which is why this table can assert rather than hedge.
  const rows: Row[] = [
    { key: "addr", value: agent.addr.slice(0, 10) + "…" + agent.addr.slice(-4), writer: "owner" },
    { key: "class", value: "Agent", writer: WRITER["class"] },
    { key: KEY_SCHEMA, value: SCHEMA_PATH, writer: WRITER[KEY_SCHEMA] },
    { key: KEY_CONTEXT, value: agent.context, writer: WRITER[KEY_CONTEXT] },
    { key: KEY_MODEL, value: agent.model, writer: WRITER[KEY_MODEL] },
    { key: KEY_RUNTIME, value: agent.runtime, writer: WRITER[KEY_RUNTIME] },
    { key: KEY_PROMPT, value: prompt, writer: WRITER[KEY_PROMPT], editable: true },
    { key: KEY_ENDPOINT_CAPSULE, value: agent.endpoint, writer: WRITER[KEY_ENDPOINT_CAPSULE] },
    { key: KEY_ENDPOINT_WEB, value: "https://t.me/" + agent.telegram.replace("@", ""), writer: WRITER[KEY_ENDPOINT_WEB] },
    { key: KEY_HEARTBEAT, value: "beat-" + agent.beats, writer: WRITER[KEY_HEARTBEAT] },
  ];

  function save(key: string) {
    setEditing(null);
    setSaved(key);
    setTimeout(() => setSaved(null), 2600);
  }

  return (
    <main className="page">
      <div className="wrap">
        <Link href="/fleet" className="hint" style={{ display: "inline-block", marginBottom: 16 }}>
          ← Fleet
        </Link>

        <div className="panel pad-lg" style={{ marginBottom: 26 }}>
          <div className="row wrapflex" style={{ gap: 18 }}>
            <Capsule size={62} cap={dead ? "#C4D5F6" : agent.cap} shell={dead ? "#E4EBFA" : "#F2F6FF"} />
            <div style={{ minWidth: 0 }}>
              <div className="ensname" style={{ fontSize: 26 }}>
                {agent.label}
                <span className="p">.{agent.parent}</span>
              </div>
              <div className="hint" style={{ marginTop: 4 }}>
                {agent.role} · {agent.model} · booted {agent.bootedAt}
              </div>
            </div>
            <div className="push row wrapflex" style={{ gap: 10 }}>
              <StatusPill status={status} />
              {!dead && (
                <button className="btn btn-sm btn-danger" onClick={() => setDialog(true)}>
                  Recall
                </button>
              )}
            </div>
          </div>

          {dead && (
            <div className="notice" style={{ marginTop: 20, borderColor: "var(--alarm)", background: "#fff" }}>
              <span className="tag ink">Recalled</span>
              <p style={{ margin: 0 }}>
                The heartbeat role was revoked {agent.recalledAt ?? "just now"}. The next write reverted with{" "}
                <span className="mono">EACUnauthorizedAccountRoles</span> and the runner exited on its own. The
                subname and its records are still yours — granting the role again brings it back.
              </p>
            </div>
          )}
        </div>

        <div className="grid g-side" style={{ gap: 26 }}>
          {/* left */}
          <div className="col" style={{ gap: 26 }}>
            <div className="panel" style={{ overflow: "hidden" }}>
              <div className="row" style={{ padding: "14px 20px", background: "var(--paper)", borderBottom: "3px solid var(--ink)" }}>
                <span className="label">The record</span>
                <span className="push hint mono" style={{ fontSize: 11.5 }}>
                  PublicResolverV2 · Sepolia
                </span>
              </div>
              <div className="scroller">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: "26%" }}>Key</th>
                      <th>Value</th>
                      <th style={{ width: "22%" }}>Who may write</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td className="m" style={{ fontWeight: 600 }}>
                          {r.key}
                        </td>
                        <td className="m" style={{ color: "var(--ink)" }}>
                          {editing === r.key ? (
                            <div className="row" style={{ gap: 8 }}>
                              <input
                                className="input"
                                autoFocus
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                              />
                              <button className="btn btn-sm btn-mint" onClick={() => save(r.key)}>
                                Write
                              </button>
                            </div>
                          ) : (
                            <div className="row" style={{ gap: 10 }}>
                              <span style={{ wordBreak: "break-word" }}>{r.value}</span>
                              {saved === r.key && (
                                <span className="pill run" style={{ flex: "none" }}>
                                  <span className="led" />
                                  written 0x3a80…11d4
                                </span>
                              )}
                              {r.editable && !dead && saved !== r.key && (
                                <button className="btn btn-sm btn-ghost push" onClick={() => setEditing(r.key)}>
                                  Edit
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                        <td>
                          {r.writer === "agent" ? (
                            <span className="tag mint">the agent</span>
                          ) : (
                            <span className="tag">owner</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="notice paper" style={{ border: 0, borderTop: "3px solid var(--ink)", borderRadius: 0 }}>
                <span className="tag ink">Note</span>
                <p style={{ margin: 0 }}>
                  <span className="mono">agent-heartbeat</span> is the only key the agent holds a role on — not by
                  convention, but because <span className="mono">authorizeTextRoles</span> granted that one key and no
                  other. Every other row is yours. Edit one and the supervisor rewrites the gateway&rsquo;s workspace
                  and restarts it on its next 30-second read — no redeploy.
                </p>
              </div>
            </div>

            <LogStream agent={{ ...agent, status }} />
          </div>

          {/* right */}
          <div className="col" style={{ gap: 26 }}>
            <div className="panel pad">
              <Heartbeat seed={agent.heartbeatAge} status={status} />
              <div style={{ marginTop: 18 }}>
                <div className="label" style={{ marginBottom: 6 }}>
                  Interval, last 12 writes
                </div>
                <Sparkline points={agent.history} broken={dead} />
                <p className="hint" style={{ marginTop: 8 }}>
                  {dead
                    ? "Flat at the configured interval, then the line stops at the revoke. No gap before it — this was a recall, not a crash."
                    : "Flat at the configured interval — 60s here, 8h in production. A gap is the first sign an agent is in trouble."}
                </p>
              </div>
            </div>

            <div className="panel pad">
              <div className="label" style={{ marginBottom: 12 }}>
                Runtime
              </div>
              <div className="stack">
                {[
                  ["Wallet", agent.addr.slice(0, 10) + "…" + agent.addr.slice(-4)],
                  ["Machine", dead ? "destroyed" : agent.machine],
                  ["Region", agent.region],
                  ["Telegram", agent.telegram],
                  ["Endpoint", agent.endpoint.replace("https://", "")],
                ].map(([k, v]) => (
                  <div key={k} className="kv" style={{ padding: "10px 0" }}>
                    <span className="hint">{k}</span>
                    <span className="mono" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right", wordBreak: "break-all" }}>
                      {v}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="panel" style={{ overflow: "hidden" }}>
              <div className="row" style={{ padding: "14px 20px", background: "var(--paper)", borderBottom: "3px solid var(--ink)" }}>
                <span className="label">OpenClaw gateway</span>
                <span className="push">
                  {dead ? (
                    <span className="pill quiet">stopped</span>
                  ) : (
                    <span className="pill run">
                      <span className="led" />
                      up
                    </span>
                  )}
                </span>
              </div>
              <div style={{ padding: "16px 20px" }}>
                <p className="hint" style={{ margin: "0 0 14px" }}>
                  Everything below was written by the supervisor from the records above. The gateway holds no key and
                  makes no chain call — it does not know ENS exists.
                </p>
                <div className="stack">
                  {[
                    ["openclaw.json", dead ? "—" : "channels.telegram · " + agent.telegram],
                    ["AGENTS.md", agent.secretsRef + " · the prompt body, unsealed at boot"],
                    ["IDENTITY.md", name + " · and what it may not change"],
                    ["model", agent.model],
                  ].map(([k, v]) => (
                    <div key={k} className="kv" style={{ padding: "10px 0" }}>
                      <span className="hint mono" style={{ fontSize: 12 }}>
                        {k}
                      </span>
                      <span
                        className="mono"
                        style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right", wordBreak: "break-all" }}
                      >
                        {v}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="notice sun" style={{ marginTop: 14 }}>
                  <span className="tag ink">Recall</span>
                  <p style={{ margin: 0 }}>
                    Pulling the heartbeat role stops this gateway before the runner exits, so the bot stops answering
                    within one tick. A kill switch that does not reach Telegram is not one.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {dialog && (
        <RecallDialog agent={agent} onClose={() => setDialog(false)} onRecalled={() => setDead(true)} />
      )}
    </main>
  );
}
