"use client";

import { useState } from "react";
import Link from "next/link";
import AgentCard from "./AgentCard";
import ActivityFeed from "./ActivityFeed";
import RecallDialog from "./RecallDialog";
import { duration } from "@/lib/format";
import type { Capsule, Fleet } from "@/lib/capsule/fleet";

/* The client half of /fleet. It holds exactly one piece of state — which
   capsule the recall dialog is open on — and derives everything else from the
   props the server read off the chain. There is no local copy of fleet status
   to drift from what the resolver says. */

export default function FleetView({ fleet }: { fleet: Fleet }) {
  const [target, setTarget] = useState<Capsule | null>(null);

  const { capsules } = fleet;
  const beating = capsules.filter((c) => c.status === "beating");
  const recalled = capsules.filter((c) => c.status === "recalled");
  const silent = capsules.filter((c) => c.status === "silent");
  const neverBooted = capsules.filter((c) => c.status === "never-booted");
  const beats = capsules.reduce((sum, c) => sum + c.beatCount, 0);

  const liveDetail = [
    silent.length > 0 && `${silent.length} silent`,
    neverBooted.length > 0 && `${neverBooted.length} never booted`,
  ]
    .filter(Boolean)
    .join(" · ");

  const stats = [
    {
      k: "Capsules minted",
      v: String(capsules.length),
      sub: `${beating.length} beating${liveDetail ? " · " + liveDetail : ""}`,
    },
    {
      k: "Beats written",
      v: String(beats),
      sub: beats === 0 ? "no agent has written yet" : "47,639 gas each, paid by the agent",
    },
    {
      k: "Recalled",
      v: String(recalled.length),
      sub: "role pulled, subname kept",
    },
    {
      k: "Parent",
      v: fleet.parent.replace(".eth", ""),
      sub: "one name, one kill switch",
    },
  ];

  return (
    <main className="page">
      <div className="wrap">
        <div className="spread wrapflex" style={{ marginBottom: 24 }}>
          <div>
            <p className="kicker" style={{ margin: 0 }}>
              Fleet
            </p>
            <h2 style={{ fontSize: 32, marginTop: 6 }}>
              {fleet.parent} has minted {capsules.length} agent{capsules.length === 1 ? "" : "s"}
            </h2>
            <p className="hint" style={{ marginTop: 6 }}>
              Every value below was read from ETH Sepolia at block {fleet.block.toString()} — the records from the
              resolver, the status from the role behind them.
            </p>
          </div>
          <Link href="/launch" className="btn btn-primary">
            Hire another →
          </Link>
        </div>

        <div className="grid g4" style={{ marginBottom: 26 }}>
          {stats.map((s) => (
            <div key={s.k} className="panel pad">
              <div className="label">{s.k}</div>
              <div className="figure" style={{ fontSize: 30, margin: "6px 0 2px" }}>
                {s.v}
              </div>
              <div className="hint">{s.sub}</div>
            </div>
          ))}
        </div>

        <div className="grid g-side" style={{ gap: 26 }}>
          <div className="grid g2">
            {capsules.map((capsule) => (
              <AgentCard key={capsule.label} capsule={capsule} now={fleet.readAt} onRecall={setTarget} />
            ))}
          </div>

          <div className="col" style={{ gap: 18 }}>
            <ActivityFeed events={fleet.events} now={fleet.readAt} limit={8} />

            <div className="notice paper">
              <span className="tag ink">Override</span>
              <p style={{ margin: 0 }}>
                Recall pulls one role and nothing else. The subname stays yours, the records stay readable, and the
                agent stops itself on its next tick.
              </p>
            </div>

            {silent.length > 0 && (
              <div className="notice paper">
                <span className="tag ink">Silent</span>
                <p style={{ margin: 0 }}>
                  {silent.length === 1 ? "One capsule holds" : `${silent.length} capsules hold`} the heartbeat role but
                  {silent.length === 1 ? " has" : " have"} not written in{" "}
                  {duration(Math.min(...silent.map((c) => c.quietFor ?? 0)))}. The permission is intact — the machine
                  is not running. That is a Fly problem, not an ENS one.
                </p>
              </div>
            )}
          </div>
        </div>

        <p className="hint" style={{ marginTop: 26 }}>
          Read at block {fleet.block.toString()} · minter {fleet.minter}
        </p>
      </div>

      {target && <RecallDialog capsule={target} now={fleet.readAt} onClose={() => setTarget(null)} />}
    </main>
  );
}
