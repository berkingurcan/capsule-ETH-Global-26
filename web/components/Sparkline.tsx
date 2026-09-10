/* Heartbeat intervals, in seconds, one point per gap between writes. A flat
   line is an agent keeping its cadence; a break is the thing the analyst looks
   for.

   The cadence is not fixed at 60 seconds — that is the demo setting, against a
   documented default of 28800 — so the axis is scaled to the values it is
   given rather than to a constant. */

export default function Sparkline({
  points,
  broken = false,
}: {
  points: number[];
  broken?: boolean;
}) {
  const w = 320;
  const h = 64;
  const pad = 6;

  if (points.length === 0) {
    // Says only what is true: there is no interval. Whether a machine is on its
    // way up is not something the chain can tell us.
    return (
      <div className="hint" style={{ padding: "18px 0" }}>
        No intervals to draw — this name has fewer than two heartbeat writes.
      </div>
    );
  }

  // Scaled to the data, with a floor on the span so a perfectly steady agent
  // does not render as a jagged line through floating-point noise.
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(max - min, Math.max(4, max * 0.1));
  const mid = (min + max) / 2;
  const lo = mid - span;
  const hi = mid + span;
  const step = (w - pad * 2) / Math.max(1, points.length - 1);
  const y = (v: number) => h - pad - ((v - lo) / (hi - lo)) * (h - pad * 2);
  const d = points.map((v, i) => (i === 0 ? "M" : "L") + (pad + i * step).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
  const lastX = pad + (points.length - 1) * step;
  const lastY = y(points[points.length - 1]);

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={
        broken
          ? `Heartbeat intervals around ${Math.round(mid)} seconds, then stopped at the recall.`
          : `Heartbeat intervals, ${Math.round(min)} to ${Math.round(max)} seconds.`
      }
      style={{ width: "100%", height: "auto", display: "block", overflow: "visible" }}
    >
      <line x1={pad} y1={y(mid)} x2={w - pad} y2={y(mid)} stroke="var(--line)" strokeWidth="2" strokeDasharray="4 5" />
      <path d={d} fill="none" stroke="var(--ink)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
      {broken ? (
        <>
          <line
            x1={lastX + 8}
            y1={pad}
            x2={lastX + 8}
            y2={h - pad}
            stroke="var(--alarm)"
            strokeWidth="3"
            strokeDasharray="5 4"
          />
          <circle cx={lastX} cy={lastY} r="5" fill="var(--alarm)" stroke="var(--ink)" strokeWidth="2.5" />
        </>
      ) : (
        <circle cx={lastX} cy={lastY} r="5" fill="var(--mint)" stroke="var(--ink)" strokeWidth="2.5" />
      )}
    </svg>
  );
}
