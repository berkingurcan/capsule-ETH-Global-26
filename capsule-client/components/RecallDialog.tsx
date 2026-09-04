"use client";

import { useEffect, useRef, useState } from "react";
import Capsule from "./Capsule";
import { fullName, type Agent } from "@/lib/mock";

/* The master override. One call — revokeRoles() — and the agent's next
   heartbeat write reverts with EACUnauthorizedAccountRoles. The runner
   reads that revert as its own stop signal. Nothing else is torn down. */

type Phase = "confirm" | "signing" | "done";

export default function RecallDialog({
  agent,
  onClose,
  onRecalled,
}: {
  agent: Agent;
  onClose: () => void;
  onRecalled: (label: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [typed, setTyped] = useState("");
  const first = useRef<HTMLInputElement>(null);
  const name = fullName(agent);
  const match = typed.trim() === name;

  useEffect(() => {
    first.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  function recall() {
    setPhase("signing");
    setTimeout(() => setPhase("done"), 1600);
  }

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label={"Recall " + name} onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div
          className="row"
          style={{ padding: "16px 22px", background: "var(--alarm)", borderBottom: "4px solid var(--ink)", color: "#fff" }}
        >
          <span className="label" style={{ color: "#fff" }}>
            Master override
          </span>
          <span className="push mono" style={{ fontSize: 12 }}>
            revokeRoles()
          </span>
        </div>

        <div style={{ padding: "24px 26px 26px" }}>
          {phase === "confirm" && (
            <>
              <div className="row" style={{ gap: 16, marginBottom: 18 }}>
                <Capsule size={52} cap={agent.cap} />
                <div>
                  <div className="ensname" style={{ fontSize: 19 }}>
                    {agent.label}
                    <span className="p">.{agent.parent}</span>
                  </div>
                  <div className="hint">
                    {agent.role} · running {agent.bootedAt}
                  </div>
                </div>
              </div>

              <p style={{ margin: "0 0 16px", fontSize: 15 }}>
                This pulls the one role the agent holds on its own name. Its next heartbeat write reverts, and the
                runner exits on that revert. It happens within 60 seconds.
              </p>

              <div className="panel flat shell" style={{ padding: "14px 18px", marginBottom: 18 }}>
                <div className="kv">
                  <span className="hint">The subname</span>
                  <b style={{ fontSize: 14 }}>stays yours</b>
                </div>
                <div className="kv">
                  <span className="hint">Records</span>
                  <b style={{ fontSize: 14 }}>kept, still readable</b>
                </div>
                <div className="kv">
                  <span className="hint">Secrets</span>
                  <b style={{ fontSize: 14 }}>wiped from the store</b>
                </div>
                <div className="kv">
                  <span className="hint">Machine</span>
                  <b style={{ fontSize: 14 }}>destroyed after exit</b>
                </div>
              </div>

              <div className="field" style={{ marginBottom: 20 }}>
                <label className="label" htmlFor="confirm-name">
                  Type the name to confirm
                </label>
                <input
                  id="confirm-name"
                  ref={first}
                  className="input"
                  placeholder={name}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div className="row" style={{ gap: 10 }}>
                <button className="btn btn-ghost" onClick={onClose}>
                  Keep it running
                </button>
                <button className="btn btn-danger push" disabled={!match} onClick={recall}>
                  Recall {agent.label}
                </button>
              </div>
            </>
          )}

          {phase === "signing" && (
            <div className="col" style={{ gap: 16, padding: "10px 0" }}>
              <div className="label">Waiting on your wallet</div>
              <pre className="term">
                <span className="d">→ </span>
                <span className="w">CapsuleMinter.recall(</span>
                <span className="y">{name}</span>
                <span className="w">)</span>
                {"\n"}
                <span className="d">  revokeRoles(resource, agent, ROLE_HEARTBEAT)</span>
                {"\n"}
                <span className="d">  waiting for signature…</span>
                <span className="caret" />
              </pre>
              <p className="hint" style={{ margin: 0 }}>
                One transaction. No other teardown is needed — the agent stops itself.
              </p>
            </div>
          )}

          {phase === "done" && (
            <div className="col" style={{ gap: 16, padding: "10px 0" }}>
              <div className="row" style={{ gap: 12 }}>
                <Capsule size={44} cap="#C4D5F6" shell="#E4EBFA" />
                <div>
                  <h3>Role revoked</h3>
                  <div className="hint mono">0x41d9…7c02 · block 7412903</div>
                </div>
              </div>
              <pre className="term">
                <span className="g">✓ revokeRoles</span> <span className="d">confirmed</span>
                {"\n"}
                <span className="d">runner </span>
                <span className="w">{name}</span>
                {"\n"}
                <span className="d">  setText(agent.heartbeat) → </span>
                <span className="r">EACUnauthorizedAccountRoles</span>
                {"\n"}
                <span className="d">  permission gone — halting</span>
                {"\n"}
                <span className="d">  telegram bot closed · exit 0</span>
              </pre>
              <button
                className="btn btn-primary"
                onClick={() => {
                  onRecalled(agent.label);
                  onClose();
                }}
              >
                Back to the fleet
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
