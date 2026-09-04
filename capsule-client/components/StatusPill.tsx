import type { Status } from "@/lib/mock";

const MAP: Record<Status, { cls: string; text: string }> = {
  running: { cls: "run", text: "Running" },
  booting: { cls: "wait", text: "Booting" },
  recalled: { cls: "dead", text: "Recalled" },
};

export default function StatusPill({ status }: { status: Status }) {
  const s = MAP[status];
  return (
    <span className={"pill " + s.cls}>
      <span className={"led" + (status === "booting" ? " pulse" : "")} />
      {s.text}
    </span>
  );
}
