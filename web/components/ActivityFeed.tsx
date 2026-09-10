import Link from "next/link";
import ChainTag from "./ChainTag";
import { ago, shortHex, txUrl } from "@/lib/format";
import type { FleetEvent } from "@/lib/capsule/fleet";

/* Every row here is an event log on ETH Sepolia — CapsuleMinted from the
   minter, TextChanged and EACRolesChanged from the resolver. The transaction
   hash links out, so any claim on this panel can be checked in one click. */

const DOT: Record<FleetEvent["kind"], string> = {
  minted: "var(--mint)",
  recalled: "var(--alarm)",
  granted: "var(--mint)",
  record: "var(--vend-300)",
  heartbeat: "var(--line)",
};

export default function ActivityFeed({
  events,
  limit,
  now,
}: {
  events: FleetEvent[];
  limit?: number;
  /** The block-read time. Fixed so server and client render the same string. */
  now: number;
}) {
  const rows = limit ? events.slice(0, limit) : events;

  return (
    <div className="panel flat" style={{ overflow: "hidden" }}>
      <div className="dashrow" style={{ background: "var(--paper)", borderBottom: "3px solid var(--ink)" }}>
        <span className="label">Fleet activity</span>
        <span className="push hint mono" style={{ fontSize: 11 }}>
          ETH Sepolia
        </span>
      </div>

      {rows.length === 0 && (
        <div className="dashrow">
          <span className="hint">No events on this minter yet.</span>
        </div>
      )}

      {rows.map((event) => (
        <div key={event.id} className="dashrow" style={{ alignItems: "flex-start" }}>
          <span
            aria-hidden="true"
            style={{
              width: 11,
              height: 11,
              borderRadius: "50%",
              background: DOT[event.kind],
              border: "2.5px solid var(--ink)",
              flex: "none",
              marginTop: 5,
            }}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="row wrapflex" style={{ gap: 8 }}>
              <b style={{ fontSize: 14.5 }}>{event.text}</b>
              <ChainTag />
            </div>
            <div className="mono" style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>
              {event.name}
              {event.detail ? " · " + event.detail : ""}
            </div>
          </div>
          <div style={{ textAlign: "right", flex: "none" }}>
            <div className="hint">{ago(event.at, now)}</div>
            <Link
              href={txUrl(event.tx)}
              target="_blank"
              rel="noreferrer"
              className="mono"
              style={{ fontSize: 11.5, color: "var(--vend-700)", textDecoration: "underline" }}
            >
              {shortHex(event.tx)}
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}
