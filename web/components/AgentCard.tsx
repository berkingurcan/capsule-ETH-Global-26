"use client";

import Link from "next/link";
import Capsule from "./Capsule";
import StatusPill from "./StatusPill";
import Heartbeat from "./Heartbeat";
import { RECORD_KEYS } from "@/lib/capsule/records";
import { capColor, roleTitle } from "@/lib/capsule/roles";
import { ago } from "@/lib/format";
import type { Capsule as CapsuleData } from "@/lib/capsule/fleet";

export default function AgentCard({
  capsule,
  now,
  onRecall,
}: {
  capsule: CapsuleData;
  /** The block-read time, so hydration matches the server render. */
  now: number;
  onRecall: (capsule: CapsuleData) => void;
}) {
  const dead = capsule.status === "recalled";
  const telegram = capsule.records.endpointWeb;
  const handle = telegram === "" ? "no bot published" : "@" + telegram.replace(/^https?:\/\/t\.me\//, "");

  return (
    <div
      className="panel"
      style={{
        padding: 0,
        overflow: "hidden",
        opacity: dead ? 0.72 : 1,
        boxShadow: dead ? "6px 6px 0 var(--line)" : undefined,
      }}
    >
      <div style={{ padding: "18px 20px 14px" }}>
        <div className="row" style={{ marginBottom: 12 }}>
          <Capsule
            size={44}
            cap={dead ? "#C4D5F6" : capColor(capsule.label)}
            shell={dead ? "#E4EBFA" : "#F2F6FF"}
          />
          <span className="push" style={{ flex: "none" }}>
            <StatusPill status={capsule.status} />
          </span>
        </div>
        <Link href={"/fleet/" + capsule.label} className="ensname" style={{ fontSize: 17, display: "block" }}>
          {capsule.label}
          <span className="p">.{capsule.parent}</span>
        </Link>
        <div className="hint" style={{ marginTop: 2 }}>
          {roleTitle(capsule.label)} · {capsule.records.model || "no model set"}
        </div>
      </div>

      <div style={{ padding: "0 20px 16px" }}>
        <Heartbeat status={capsule.status} quietFor={capsule.quietFor} cadence={capsule.cadence} />
      </div>

      <div className="row" style={{ padding: "12px 20px", borderTop: "2px solid var(--line)", gap: 22 }}>
        <div>
          <div className="label">{RECORD_KEYS.prompt}</div>
          <div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>
            {capsule.records.prompt || "—"}
          </div>
        </div>
        <div>
          <div className="label">{RECORD_KEYS.heartbeat}</div>
          <div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>
            {capsule.records.heartbeat || "—"}
          </div>
        </div>
        <div>
          <div className="label">{RECORD_KEYS.runtime}</div>
          <div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>
            {capsule.records.runtime || "—"}
          </div>
        </div>
      </div>

      <div className="row" style={{ padding: "12px 20px 16px", borderTop: "2px solid var(--line)", gap: 10 }}>
        <Link href={"/fleet/" + capsule.label} className="btn btn-sm">
          Open
        </Link>
        <span className="mono hint push" style={{ fontSize: 11.5 }}>
          {dead ? "recalled " + ago(capsule.recalledAt?.at ?? null, now) : handle}
        </span>
        {!dead && (
          <button className="btn btn-sm btn-danger" onClick={() => onRecall(capsule)}>
            Recall
          </button>
        )}
      </div>
    </div>
  );
}
