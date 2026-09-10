"use client";

import { useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import CapsuleMark from "./Capsule";
import StatusPill from "./StatusPill";
import Heartbeat from "./Heartbeat";
import Sparkline from "./Sparkline";
import ChainLog from "./ChainLog";
import { RECORD_KEYS } from "@/lib/capsule/records";
import { capColor, roleTitle } from "@/lib/capsule/roles";
import { ago, addressUrl, duration, shortHex, txUrl } from "@/lib/format";
import type { Capsule } from "@/lib/capsule/fleet";

/* Loaded on click, not on load. The dialog is the only part of the dashboard
   that signs anything, so it carries viem's write path — about 120kB that a
   page whose job is reading the chain should not make every visitor download
   to look at four cards. The scrim is drawn immediately so the click lands
   somewhere while the chunk arrives. */
const RecallDialog = dynamic(() => import("./RecallDialog"), {
  ssr: false,
  loading: () => <div className="scrim" aria-hidden />,
});

/* The record table is the whole argument of the project, so it shows the nine
   keys the mint actually writes plus the ENSIP-25 registration, and nothing
   else. Every value is read from the resolver — nothing on this page is a
   fixture, and where a value is absent the cell says so rather than filling in.

   Keys are imported, never spelled. A literal here that drifts from
   CapsuleMinter.sol is invisible: the resolver reverts against the name-level
   resource whichever key was denied, so a typo reads exactly like a revoked
   permission. */

type Row = {
  key: string;
  value: string;
  writer: "owner" | "agent";
  note?: string;
  missing?: boolean;
};

export default function AgentDetail({ capsule, now }: { capsule: Capsule; now: number }) {
  const [dialog, setDialog] = useState(false);
  const dead = capsule.status === "recalled";
  const cap = capColor(capsule.label);

  function row(key: string, value: string, writer: "owner" | "agent", note?: string): Row {
    return { key, value: value === "" ? "— not set" : value, writer, note, missing: value === "" };
  }

  const rows: Row[] = [
    row("addr", capsule.addr, "owner", "the agent's own EOA"),
    row(RECORD_KEYS.class, capsule.records.class, "owner", "ENSIP-27"),
    row(RECORD_KEYS.schema, capsule.records.schema, "owner", "ENSIP-27"),
    row(RECORD_KEYS.context, capsule.records.context, "owner", "ENSIP-26"),
    row(RECORD_KEYS.endpointWeb, capsule.records.endpointWeb, "owner", "ENSIP-26"),
    row(RECORD_KEYS.endpointCapsule, capsule.records.endpointCapsule, "owner", "ENSIP-26"),
    row(RECORD_KEYS.model, capsule.records.model, "owner"),
    row(RECORD_KEYS.runtime, capsule.records.runtime, "owner"),
    row(RECORD_KEYS.prompt, capsule.records.prompt, "owner", "a pointer, never the body"),
    row(capsule.registrationKey, capsule.registrationValue, "owner", "ENSIP-25"),
    row(RECORD_KEYS.heartbeat, capsule.records.heartbeat, "agent", "the only key the agent may write"),
  ];

  const telegram = capsule.records.endpointWeb;
  const lastPromptWrite = capsule.writes.find((w) => w.key === RECORD_KEYS.prompt && w.block !== capsule.mintedAt.block);

  return (
    <main className="page">
      <div className="wrap">
        {/* Back to the fleet this capsule is actually in, not to the default one.
            An unqualified "← Fleet" is the rare broken link that looks like it
            worked: it lands on a real page, with a real heading, listing real
            capsules — just somebody else's. */}
        <Link
          href={`/fleet?parent=${encodeURIComponent(capsule.parent)}`}
          className="hint"
          style={{ display: "inline-block", marginBottom: 16 }}
        >
          ← Fleet
        </Link>

        <div className="panel pad-lg" style={{ marginBottom: 26 }}>
          <div className="row wrapflex" style={{ gap: 18 }}>
            <CapsuleMark size={62} cap={dead ? "#C4D5F6" : cap} shell={dead ? "#E4EBFA" : "#F2F6FF"} />
            <div style={{ minWidth: 0 }}>
              <div className="ensname" style={{ fontSize: 26 }}>
                {capsule.label}
                <span className="p">.{capsule.parent}</span>
              </div>
              <div className="hint" style={{ marginTop: 4 }}>
                {roleTitle(capsule.label)} · {capsule.records.model || "no model set"} · minted{" "}
                {ago(capsule.mintedAt.at, now)}
              </div>
            </div>
            <div className="push row wrapflex" style={{ gap: 10 }}>
              <StatusPill status={capsule.status} />
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
                The heartbeat role was revoked {ago(capsule.recalledAt?.at ?? null, now)}
                {capsule.recalledAt && (
                  <>
                    {" "}
                    in{" "}
                    <Link href={txUrl(capsule.recalledAt.tx)} target="_blank" rel="noreferrer" className="mono">
                      {shortHex(capsule.recalledAt.tx)}
                    </Link>
                  </>
                )}
                . The next write reverted with <span className="mono">EACUnauthorizedAccountRoles</span> and the runner
                exited on its own. The subname and its records are still yours — granting the role again brings it back.
              </p>
            </div>
          )}

          {capsule.status === "silent" && (
            <div className="notice" style={{ marginTop: 20, borderColor: "var(--sun)", background: "#fff" }}>
              <span className="tag ink">Silent</span>
              <p style={{ margin: 0 }}>
                The role is still granted — <span className="mono">hasRoles</span> says so — but nothing has written{" "}
                <span className="mono">{RECORD_KEYS.heartbeat}</span> in {duration(capsule.quietFor ?? 0)}, against an
                observed cadence of {capsule.cadence === null ? "unknown" : duration(capsule.cadence)}. The permission
                is fine; the machine is not running.
              </p>
            </div>
          )}

          {capsule.status === "never-booted" && (
            <div className="notice paper" style={{ marginTop: 20 }}>
              <span className="tag ink">Never booted</span>
              <p style={{ margin: 0 }}>
                Minted, records written, heartbeat role granted — and no agent has ever written to it. The name is
                ready; nothing has claimed it yet.
              </p>
            </div>
          )}
        </div>

        <div className="grid g-side" style={{ gap: 26 }}>
          {/* left */}
          <div className="col" style={{ gap: 26 }}>
            <div className="panel" style={{ overflow: "hidden" }}>
              <div
                className="row"
                style={{ padding: "14px 20px", background: "var(--paper)", borderBottom: "3px solid var(--ink)" }}
              >
                <span className="label">The record</span>
                <Link
                  href={addressUrl(capsule.resolver)}
                  target="_blank"
                  rel="noreferrer"
                  className="push hint mono"
                  style={{ fontSize: 11.5 }}
                >
                  PermissionedResolver {shortHex(capsule.resolver)} · Sepolia
                </Link>
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
                        <td
                          className="m"
                          style={{ color: r.missing ? "var(--muted)" : "var(--ink)", wordBreak: "break-word" }}
                        >
                          {r.value}
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
                  Every other row is yours.
                  {lastPromptWrite ? (
                    <>
                      {" "}
                      <span className="mono">{RECORD_KEYS.prompt}</span> was last rewritten {ago(lastPromptWrite.at, now)} in{" "}
                      <Link href={txUrl(lastPromptWrite.tx)} target="_blank" rel="noreferrer" className="mono">
                        {shortHex(lastPromptWrite.tx)}
                      </Link>{" "}
                      — the runner picked it up on its next read, with no redeploy.
                    </>
                  ) : (
                    " Editing one is wired up with the mint flow."
                  )}
                </p>
              </div>
            </div>

            <ChainLog capsule={capsule} now={now} />
          </div>

          {/* right */}
          <div className="col" style={{ gap: 26 }}>
            <div className="panel pad">
              <Heartbeat status={capsule.status} quietFor={capsule.quietFor} cadence={capsule.cadence} />
              <div style={{ marginTop: 18 }}>
                <div className="label" style={{ marginBottom: 6 }}>
                  Interval between writes, seconds
                </div>
                <Sparkline points={capsule.intervals} broken={dead} />
                <p className="hint" style={{ marginTop: 8 }}>
                  {capsule.intervals.length === 0
                    ? "Fewer than two heartbeats on this name — there is no interval to draw yet."
                    : dead
                      ? `${capsule.beatCount} writes, then the line stops at the revoke. No gap before it — this was a recall, not a crash.`
                      : `${capsule.beatCount} writes, median ${duration(capsule.cadence ?? 0)}. A gap here is the first sign an agent is in trouble.`}
                </p>
              </div>
            </div>

            <div className="panel pad">
              <div className="label" style={{ marginBottom: 12 }}>
                Identity
              </div>
              <div className="stack">
                {[
                  ["Owner", shortHex(capsule.owner, 10, 6), addressUrl(capsule.owner)],
                  ["Agent wallet", shortHex(capsule.agent, 10, 6), addressUrl(capsule.agent)],
                  ["Token id", shortHex(capsule.tokenId.toString(), 8, 6), null],
                  ["Minted in", shortHex(capsule.mintedAt.tx), txUrl(capsule.mintedAt.tx)],
                  ["Expires", capsule.expiry === 0 ? "—" : new Date(capsule.expiry * 1000).toISOString().slice(0, 10), null],
                  ["Telegram", telegram === "" ? "not published" : telegram.replace("https://", ""), telegram || null],
                ].map(([k, v, href]) => (
                  <div key={k as string} className="kv" style={{ padding: "10px 0" }}>
                    <span className="hint">{k}</span>
                    <span
                      className="mono"
                      style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right", wordBreak: "break-all" }}
                    >
                      {href ? (
                        <Link href={href as string} target="_blank" rel="noreferrer">
                          {v}
                        </Link>
                      ) : (
                        v
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="notice paper">
              <span className="tag ink">Runtime</span>
              <p style={{ margin: 0 }}>
                Machine id, region and live stdout come from Fly, and the provisioner that would report them is the
                next thing to build. Everything on this page is read from the chain instead.
              </p>
            </div>
          </div>
        </div>
      </div>

      {dialog && <RecallDialog capsule={capsule} now={now} onClose={() => setDialog(false)} />}
    </main>
  );
}
