/* The mark. Coloured cap, clear shell, printed label bar.
   The cap takes the role colour; the shell half never does.
   A greyed capsule is a slot nobody has filled yet. */

export default function Capsule({
  size = 48,
  cap = "#FF4D8D",
  shell = "#F2F6FF",
  ink = "#12203F",
  title,
}: {
  size?: number;
  cap?: string;
  shell?: string;
  ink?: string;
  title?: string;
}) {
  const stroke = Math.max(3, (size / 96) * 6);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ display: "block", flex: "none" }}
    >
      <path d="M12 48 A36 36 0 0 1 84 48 Z" fill={cap} />
      <path d="M12 48 A36 36 0 0 0 84 48 Z" fill={shell} />
      <rect x="30" y="59" width="36" height="9" rx="4.5" fill={ink} />
      <circle cx="48" cy="48" r="36" fill="none" stroke={ink} strokeWidth={(stroke / size) * 96} />
      <path d="M12 48 H84" stroke={ink} strokeWidth={(stroke / size) * 96} />
    </svg>
  );
}
