"use client";

import Link from "next/link";
import Capsule from "./Capsule";
import StatusPill from "./StatusPill";
import Heartbeat from "./Heartbeat";
import { fullName, usd, type Agent } from "@/lib/mock";

export default function AgentCard({ agent, onRecall }: { agent: Agent; onRecall: (a: Agent) => void }) {
  const dead = agent.status === "recalled";

  return (
    <div
      className="panel"
      style={{
        padding: 0,
        overflow: "hidden",
        opacity: dead ? 0.72 : 1,
        boxShadow: dead ? "6px 6px 0 var(--line)" : undefined,
      }}
    >
      <div style={{ padding: "18px 20px 14px" }}>
        <div className="row" style={{ marginBottom: 12 }}>
          <Capsule size={44} cap={dead ? "#C4D5F6" : agent.cap} shell={dead ? "#E4EBFA" : "#F2F6FF"} />
          <span className="push" style={{ flex: "none" }}>
            <StatusPill status={agent.status} />
          </span>
        </div>
        <Link href={"/fleet/" + agent.label} className="ensname" style={{ fontSize: 17, display: "block" }}>
          {agent.label}
          <span className="p">.{agent.parent}</span>
        </Link>
        <div className="hint" style={{ marginTop: 2 }}>
          {agent.role} · {agent.model}
        </div>
      </div>

      <div style={{ padding: "0 20px 16px" }}>
        <Heartbeat seed={agent.heartbeatAge} status={agent.status} />
      </div>

      <div className="row" style={{ padding: "12px 20px", borderTop: "2px solid var(--line)", gap: 22 }}>
        <div>
          <div className="label">Balance</div>
          <div className="figure" style={{ fontSize: 16 }}>
            {usd(agent.balance)} <span style={{ fontSize: 11, color: "var(--muted)" }}>USDC</span>
          </div>
        </div>
        <div>
          <div className="label">Net</div>
          <div className="figure" style={{ fontSize: 16, color: agent.earned - agent.spent >= 0 ? "var(--mint-700)" : "var(--alarm)" }}>
            {agent.earned - agent.spent >= 0 ? "+" : "−"}
            {usd(Math.abs(agent.earned - agent.spent))}
          </div>
        </div>
        <div>
          <div className="label">Calls</div>
          <div className="figure" style={{ fontSize: 16 }}>
            {agent.calls}
          </div>
        </div>
      </div>

      <div className="row" style={{ padding: "12px 20px 16px", borderTop: "2px solid var(--line)", gap: 10 }}>
        <Link href={"/fleet/" + agent.label} className="btn btn-sm">
          Open
        </Link>
        <span className="mono hint push" style={{ fontSize: 11.5 }}>
          {dead ? "recalled " + agent.recalledAt : agent.telegram}
        </span>
        {!dead && (
          <button className="btn btn-sm btn-danger" onClick={() => onRecall(agent)}>
            Recall
          </button>
        )}
      </div>
    </div>
  );
}
