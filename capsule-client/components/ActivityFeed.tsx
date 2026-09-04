import Link from "next/link";
import ChainTag from "./ChainTag";
import { EVENTS, type Event } from "@/lib/mock";

const DOT: Record<Event["kind"], string> = {
  minted: "var(--mint)",
  recalled: "var(--alarm)",
  record: "var(--vend-300)",
  role: "var(--sun)",
  payment: "var(--bubble)",
  heartbeat: "var(--line)",
};

export default function ActivityFeed({ limit }: { limit?: number }) {
  const rows = limit ? EVENTS.slice(0, limit) : EVENTS;

  return (
    <div className="panel flat" style={{ overflow: "hidden" }}>
      <div className="dashrow" style={{ background: "var(--paper)", borderBottom: "3px solid var(--ink)" }}>
        <span className="label">Fleet activity</span>
        <span className="push hint mono" style={{ fontSize: 11 }}>
          subgraph-sepolia + subgraph-base
        </span>
      </div>

      {rows.map((e) => (
        <div key={e.id} className="dashrow" style={{ alignItems: "flex-start" }}>
          <span
            aria-hidden="true"
            style={{
              width: 11,
              height: 11,
              borderRadius: "50%",
              background: DOT[e.kind],
              border: "2.5px solid var(--ink)",
              flex: "none",
              marginTop: 5,
            }}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="row wrapflex" style={{ gap: 8 }}>
              <b style={{ fontSize: 14.5 }}>{e.text}</b>
              <ChainTag chain={e.chain} />
            </div>
            <div className="mono" style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>
              {e.name}
              {e.detail ? " · " + e.detail : ""}
            </div>
          </div>
          <div style={{ textAlign: "right", flex: "none" }}>
            <div className="hint">{e.at}</div>
            <Link
              href="/fleet"
              className="mono"
              style={{ fontSize: 11.5, color: "var(--vend-700)", textDecoration: "underline" }}
            >
              {e.tx}
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}
