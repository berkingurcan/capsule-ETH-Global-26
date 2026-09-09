"use client";

import { useEffect, useState } from "react";
import { duration } from "@/lib/format";
import type { CapsuleStatus } from "@/lib/capsule/fleet";

/* The agent writes agent-heartbeat to its own name on a schedule. That write is
   the thing the EAC role gates, so this is not decoration — it is the agent
   proving it still holds a permission it cannot grant itself.

   The cadence is NOT read from the chain, because it is not on the chain: it
   lives in the runner's environment as HEARTBEAT_SECONDS. So the bar measures
   against the interval this name has actually been keeping, and says "cadence
   unknown" when it has not written twice yet. Inventing 60 seconds here would
   show a capsule on a documented 8-hour schedule as permanently overdue. */

export default function Heartbeat({
  status,
  quietFor,
  cadence,
  compact = false,
}: {
  status: CapsuleStatus;
  /** Seconds since the last heartbeat write, or null if it never wrote one. */
  quietFor: number | null;
  /** Observed median interval, or null with fewer than two writes. */
  cadence: number | null;
  compact?: boolean;
}) {
  // Server-rendered age plus a client-side tick. The seed is the real gap
  // between the last block's timestamp and now; the interval only keeps it
  // honest as the page sits open.
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (status === "recalled" || quietFor === null) return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [status, quietFor]);

  const label = !compact && <span className="label">Heartbeat</span>;

  if (status === "never-booted") {
    return (
      <div className="col" style={{ gap: 6 }}>
        {label}
        <span className="mono" style={{ fontSize: 13, color: "var(--muted)" }}>
          never written
        </span>
        <div className="meter" aria-hidden="true">
          <span style={{ width: "0%" }} />
        </div>
      </div>
    );
  }

  if (status === "recalled") {
    return (
      <div className="col" style={{ gap: 6 }}>
        {label}
        <span className="mono" style={{ fontSize: 13, color: "var(--alarm)", fontWeight: 600 }}>
          role revoked · writes revert
        </span>
        <div className="meter hot" aria-hidden="true">
          <span style={{ width: "100%" }} />
        </div>
      </div>
    );
  }

  const age = (quietFor ?? 0) + elapsed;
  const overdue = status === "silent";
  const pct = cadence === null ? (overdue ? 100 : 12) : Math.min(100, (age / cadence) * 100);

  return (
    <div className="col" style={{ gap: 6 }}>
      {label}
      <span className="mono" style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
        wrote {duration(age)} ago
        <span style={{ color: "var(--muted)" }}>
          {cadence === null
            ? " · cadence unknown"
            : overdue
              ? ` · overdue, was every ${duration(cadence)}`
              : ` · every ${duration(cadence)}`}
        </span>
      </span>
      <div className={"meter" + (overdue ? " warn" : "")} aria-hidden="true">
        <span style={{ width: pct + "%" }} />
      </div>
    </div>
  );
}
