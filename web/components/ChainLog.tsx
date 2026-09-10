import Link from "next/link";
import { RECORD_KEYS } from "@/lib/capsule/records";
import { ago, shortHex, txUrl } from "@/lib/format";
import type { Capsule } from "@/lib/capsule/fleet";

/* What used to be here was a fake terminal: hardcoded lines on a 2.6s timer,
   with block numbers that were typed rather than read.

   This is the real thing that log was pretending to be. Every row is a
   TextChanged event on this name, from the resolver, with the transaction that
   caused it — which is strictly more than stdout could tell you, because it
   also says who was allowed to write it.

   The runner's actual stdout lives on Fly and is not wired up yet; that arrives
   with the provisioner. Until then this panel does not pretend to have it. */

function paint(key: string): string {
  if (key === RECORD_KEYS.heartbeat) return "g";
  if (key === RECORD_KEYS.prompt) return "y";
  return "w";
}

export default function ChainLog({
  capsule,
  now,
  height = 260,
}: {
  capsule: Capsule;
  /** The block-read time, so hydration matches the server render. */
  now: number;
  height?: number;
}) {
  return (
    <div className="panel flat" style={{ overflow: "hidden", background: "var(--ink)", borderColor: "var(--ink)" }}>
      <div
        className="row"
        style={{ padding: "10px 18px", borderBottom: "2px solid var(--ink-soft)", background: "var(--ink-deep)" }}
      >
        <span className="label" style={{ color: "var(--vend-300)" }}>
          Record writes
        </span>
        <span className="push mono" style={{ fontSize: 11, color: "var(--vend-300)" }}>
          {capsule.writes.length} on chain · newest first
        </span>
      </div>

      <div className="term flush" style={{ height, overflowY: "auto" }}>
        {capsule.writes.length === 0 && <span className="d">— no writes on this name —</span>}
        {capsule.writes.map((write) => (
          <div key={`${write.tx}-${write.key}-${write.block}`} style={{ display: "flex", gap: 10, padding: "1px 0" }}>
            <span className="d" style={{ flex: "none", minWidth: 92 }}>
              {ago(write.at, now)}
            </span>
            <span className={paint(write.key)} style={{ flex: "none", minWidth: 190 }}>
              {write.key}
            </span>
            <span className="w" style={{ flex: 1, minWidth: 0, wordBreak: "break-all" }}>
              {write.value === "" ? "(cleared)" : write.value}
            </span>
            <span className="d" style={{ flex: "none" }}>
              {write.byAgent ? "agent" : "owner"}
            </span>
            <Link
              href={txUrl(write.tx)}
              target="_blank"
              rel="noreferrer"
              className="d"
              style={{ flex: "none", textDecoration: "underline" }}
            >
              {shortHex(write.tx)}
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
