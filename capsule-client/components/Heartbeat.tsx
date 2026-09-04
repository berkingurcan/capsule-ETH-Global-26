"use client";

import { useEffect, useState } from "react";

/* The agent writes agent.heartbeat to its own name every 60 seconds.
   That write is the thing the EAC role gates — so this counter is not
   decoration, it is the agent proving it still holds permission. */

export default function Heartbeat({
  seed,
  status,
  compact = false,
}: {
  seed: number;
  status: "running" | "booting" | "recalled";
  compact?: boolean;
}) {
  const [age, setAge] = useState(seed);

  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => setAge((a) => (a >= 60 ? 0 : a + 1)), 1000);
    return () => clearInterval(t);
  }, [status]);

  if (status === "booting") {
    return (
      <div className="col" style={{ gap: 6 }}>
        {!compact && <span className="label">Heartbeat</span>}
        <span className="mono" style={{ fontSize: 13, color: "var(--muted)" }}>
          waiting for first write
        </span>
        <div className="meter warn" aria-hidden="true">
          <span style={{ width: "8%" }} />
        </div>
      </div>
    );
  }

  if (status === "recalled") {
    return (
      <div className="col" style={{ gap: 6 }}>
        {!compact && <span className="label">Heartbeat</span>}
        <span className="mono" style={{ fontSize: 13, color: "var(--alarm)", fontWeight: 600 }}>
          write reverted
        </span>
        <div className="meter hot" aria-hidden="true">
          <span style={{ width: "100%" }} />
        </div>
      </div>
    );
  }

  const pct = Math.min(100, (age / 60) * 100);

  return (
    <div className="col" style={{ gap: 6 }}>
      {!compact && <span className="label">Heartbeat</span>}
      <span className="mono" style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
        wrote {age}s ago
        <span style={{ color: "var(--muted)" }}> · next in {60 - age}s</span>
      </span>
      <div className="meter" aria-hidden="true">
        <span style={{ width: pct + "%" }} />
      </div>
    </div>
  );
}
