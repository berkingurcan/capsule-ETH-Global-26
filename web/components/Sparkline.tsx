/* Heartbeat intervals, one point a minute. A flat line is a healthy
   agent — every write landed at 60 seconds. A break in the line is the
   thing the analyst looks for. */

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
    return (
      <div className="hint" style={{ padding: "18px 0" }}>
        No writes yet — the runner is still booting.
      </div>
    );
  }

  const lo = 55;
  const hi = 70;
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
          ? "Heartbeat intervals held at 60 seconds, then stopped at the recall."
          : "Heartbeat intervals holding steady at 60 seconds."
      }
      style={{ width: "100%", height: "auto", display: "block", overflow: "visible" }}
    >
      <line x1={pad} y1={y(60)} x2={w - pad} y2={y(60)} stroke="var(--line)" strokeWidth="2" strokeDasharray="4 5" />
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
