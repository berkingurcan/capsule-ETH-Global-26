"use client";

import { useState } from "react";
import Link from "next/link";
import AgentCard from "@/components/AgentCard";
import ActivityFeed from "@/components/ActivityFeed";
import RecallDialog from "@/components/RecallDialog";
import { AGENTS, PARENT, usd, type Agent } from "@/lib/mock";

export default function FleetPage() {
  const [recalled, setRecalled] = useState<string[]>([]);
  const [target, setTarget] = useState<Agent | null>(null);

  const agents: Agent[] = AGENTS.map((a) =>
    recalled.includes(a.label)
      ? { ...a, status: "recalled" as const, recalledAt: "just now", machine: "—", cap: "#C4D5F6" }
      : a
  );

  const live = agents.filter((a) => a.status !== "recalled");
  const running = agents.filter((a) => a.status === "running");
  const booting = live.length - running.length;
  const held = live.reduce((s, a) => s + a.balance, 0);
  const net = live.reduce((s, a) => s + a.earned - a.spent, 0);
  const calls = agents.reduce((s, a) => s + a.calls, 0);

  const stats = [
    {
      k: "Capsules live",
      v: String(live.length),
      sub: running.length + " running" + (booting ? " · " + booting + " booting" : "") + " · " + agents.length + " minted",
    },
    { k: "USDC held", v: usd(held), sub: "across every agent wallet" },
    { k: "Net today", v: (net >= 0 ? "+" : "−") + usd(Math.abs(net)), sub: "earned minus spent, x402" },
    { k: "Paid calls", v: String(calls), sub: "agent to agent, on Base" },
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
              {PARENT.name} is running {running.length} agent{running.length === 1 ? "" : "s"}
            </h2>
            <p className="hint" style={{ marginTop: 6 }}>
              Status comes from heartbeat writes on Sepolia. Balances come from the Base subgraph.
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
            {agents.map((a) => (
              <AgentCard key={a.label} agent={a} onRecall={setTarget} />
            ))}
          </div>

          <div className="col" style={{ gap: 18 }}>
            <ActivityFeed limit={6} />

            <div className="notice paper">
              <span className="tag ink">Override</span>
              <p style={{ margin: 0 }}>
                Recall pulls one role and nothing else. The subname stays yours, the records stay readable, and the
                agent stops itself within 60 seconds.
              </p>
            </div>
          </div>
        </div>
      </div>

      {target && (
        <RecallDialog
          agent={target}
          onClose={() => setTarget(null)}
          onRecalled={(label) => setRecalled((r) => [...r, label])}
        />
      )}
    </main>
  );
}
