import type { CapsuleStatus } from "@/lib/capsule/fleet";

/* Four states, because the chain can distinguish four.
   `never-booted` and `silent` were one state ("booting") in the mock, which
   asserted a machine was on its way up. Nothing on chain says that. */
const MAP: Record<CapsuleStatus, { cls: string; text: string; title: string }> = {
  beating: { cls: "run", text: "Beating", title: "The agent is writing agent-heartbeat on schedule." },
  silent: {
    cls: "wait",
    text: "Silent",
    title: "The role is still granted, but no heartbeat has landed in three intervals.",
  },
  "never-booted": {
    cls: "quiet",
    text: "Never booted",
    title: "Minted and authorised, but the agent has never written a heartbeat.",
  },
  recalled: { cls: "dead", text: "Recalled", title: "The heartbeat role was revoked. Writes revert." },
};

export default function StatusPill({ status }: { status: CapsuleStatus }) {
  const s = MAP[status];
  return (
    <span className={"pill " + s.cls} title={s.title}>
      <span className={"led" + (status === "silent" ? " pulse" : "")} />
      {s.text}
    </span>
  );
}
