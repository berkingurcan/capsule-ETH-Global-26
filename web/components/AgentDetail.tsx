"use client";

import { useState } from "react";
import Link from "next/link";
import Capsule from "./Capsule";
import StatusPill from "./StatusPill";
import Heartbeat from "./Heartbeat";
import Sparkline from "./Sparkline";
import LogStream from "./LogStream";
import RecallDialog from "./RecallDialog";
import { RECORD_KEYS } from "@/lib/capsule/records";
import { fullName, type Agent } from "@/lib/mock";

/* The record table is the whole argument of the project, so it shows the
   nine keys the mint actually writes and nothing else — no `agent.tools`,
   no `agent.price`, no `agent.secrets`. Those were invented by an earlier
   mock and never existed on chain.

   Keys are imported, never spelled. A literal here that drifts from
   CapsuleMinter.sol is invisible: the resolver reverts against the
   name-level resource whichever key was denied, so a typo reads exactly
   like a revoked permission. */

type Row = {
  key: string;
  value: string;
  writer: "owner" | "agent";
  editable?: boolean;
  note?: string;
};

export default function AgentDetail({ agent }: { agent: Agent }) {
  const [dead, setDead] = useState(agent.status === "recalled");
  const [dialog, setDialog] = useState(false);
  const [promptRef, setPromptRef] = useState(agent.promptRef);
  const [editing, setEditing] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const status = dead ? ("recalled" as const) : agent.status;
  const name = fullName(agent);
  const short = agent.addr.slice(0, 10) + "…" + agent.addr.slice(-4);

  const rows: Row[] = [
    { key: "addr", value: short, writer: "owner", note: "the agent's own EOA" },
    { key: RECORD_KEYS.class, value: "Agent", writer: "owner", note: "ENSIP-27" },
    { key: RECORD_KEYS.schema, value: agent.schemaUri, writer: "owner", note: "ENSIP-27" },
    { key: RECORD_KEYS.context, value: agent.context, writer: "owner", note: "ENSIP-26" },
    { key: RECORD_KEYS.endpointWeb, value: agent.telegramUrl, writer: "owner", note: "ENSIP-26" },
    { key: RECORD_KEYS.endpointCapsule, value: agent.capsuleEndpoint, writer: "owner", note: "ENSIP-26" },
    { key: RECORD_KEYS.model, value: agent.model, writer: "owner" },
    { key: RECORD_KEYS.runtime, value: agent.runtime, writer: "owner" },
    { key: RECORD_KEYS.prompt, value: promptRef, writer: "owner", editable: true, note: "a pointer, never the body" },
    { key: agent.registration, value: "1", writer: "owner", note: "ENSIP-25" },
    {
      key: RECORD_KEYS.heartbeat,
      value: agent.heartbeat === "" ? "— never written" : agent.heartbeat,
      writer: "agent",
    },
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
                  PermissionedResolver · Sepolia
                </span>
              </div>
              <div className="scroller">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: "30%" }}>Key</th>
                      <th>Value</th>
                      <th style={{ width: "20%" }}>Who may write</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key}>
                        <td className="m" style={{ fontWeight: 600, wordBreak: "break-all" }}>
                          {r.key}
                          {r.note && (
                            <div className="hint" style={{ fontWeight: 400, marginTop: 2 }}>
                              {r.note}
                            </div>
                          )}
                        </td>
                        <td className="m" style={{ color: "var(--ink)" }}>
                          {editing === r.key ? (
                            <div className="row" style={{ gap: 8 }}>
                              <input
                                className="input"
                                autoFocus
                                value={promptRef}
                                onChange={(e) => setPromptRef(e.target.value)}
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
                                  written 0x9aa2…f2a2
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
                  <span className="mono">{RECORD_KEYS.heartbeat}</span> is the only key the agent holds a role on.
                  Every other row is yours. Edit one and the runner picks it up on its next 30-second read — no
                  redeploy.
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
                    ? "Flat at 60 seconds, then the line stops at the revoke. No gap before it — this was a recall, not a crash."
                    : "Flat at 60 seconds. A gap here is the first sign an agent is in trouble."}
                </p>
              </div>
            </div>

            <div className="panel pad">
              <div className="label" style={{ marginBottom: 12 }}>
                Runtime
              </div>
              <div className="stack">
                {[
                  ["Wallet", short],
                  ["Machine", dead ? "destroyed" : agent.machine],
                  ["Region", agent.region],
                  ["Telegram", agent.telegram],
                  ["Control plane", agent.capsuleEndpoint.replace("https://", "")],
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

            <div className="notice paper">
              <span className="tag ink">Gas</span>
              <p style={{ margin: 0 }}>
                A beat costs 47,639 gas, measured. The agent wallet pays for it and holds nothing else — it is the
                least privileged key in the system: one text record, on one name.
              </p>
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
