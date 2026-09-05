"use client";

import { useEffect, useRef, useState } from "react";
import type { Agent } from "@/lib/mock";

/* Fly streams the runner's stdout straight into the dashboard, so there
   is no log service to build. In the demo the lines arrive on a timer. */

const MORE: Record<string, string[]> = {
  trader: [
    "ETH/USDC 3,219.05 · would wait — spread 0.4%",
    "heartbeat written · block 7412891",
    "telegram: answered @berkin in 620ms",
    "heartbeat written · block 7412895",
  ],
  dev: [
    "scanning capsule/runner · no changes",
    "heartbeat written · block 7412892",
    "telegram: sent commit digest",
  ],
  marketing: [
    "resolved marketing.berkin.eth · 6 records",
    "model=claude-sonnet-5 tools=draft,schedule,notify",
    "secrets cap_71a4ef unsealed",
    "telegram bot online · @berkin_mktg_bot",
    "heartbeat written · block 7412896",
  ],
  research: [],
};

function paint(line: string) {
  if (line.includes("revert") || line.includes("EACUnauthorized")) return "r";
  if (line.startsWith("heartbeat")) return "g";
  if (line.startsWith("x402")) return "p";
  if (line.startsWith("telegram")) return "y";
  return "w";
}

export default function LogStream({ agent, height = 260 }: { agent: Agent; height?: number }) {
  const [lines, setLines] = useState<string[]>(agent.logs);
  const box = useRef<HTMLPreElement>(null);
  const queue = useRef<string[]>([...(MORE[agent.label] ?? [])]);

  useEffect(() => {
    if (agent.status === "recalled") return;
    const t = setInterval(() => {
      const next = queue.current.shift();
      if (!next) return clearInterval(t);
      setLines((l) => [...l, next]);
    }, 2600);
    return () => clearInterval(t);
  }, [agent.status]);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  const live = agent.status !== "recalled";

  return (
    <div className="panel flat" style={{ overflow: "hidden", background: "var(--ink)", borderColor: "var(--ink)" }}>
      <div
        className="row"
        style={{ padding: "10px 18px", borderBottom: "2px solid var(--ink-soft)", background: "var(--ink-deep)" }}
      >
        <span className="label" style={{ color: "var(--vend-300)" }}>
          Runner log
        </span>
        <span className="push mono" style={{ fontSize: 11, color: "var(--vend-300)" }}>
          fly · {agent.machine} · {agent.region}
        </span>
      </div>
      <pre ref={box} className="term flush" style={{ height, overflowY: "auto" }}>
        {lines.map((l, i) => (
          <span key={i} className={paint(l)}>
            {l}
            {"\n"}
          </span>
        ))}
        {live ? <span className="caret" /> : <span className="d">— stream closed —</span>}
      </pre>
    </div>
  );
}
