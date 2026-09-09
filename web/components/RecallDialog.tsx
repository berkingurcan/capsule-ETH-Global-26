"use client";

import { useEffect, useRef, useState } from "react";
import CapsuleMark from "./Capsule";
import { RECORD_KEYS } from "@/lib/capsule/records";
import { capColor, roleTitle } from "@/lib/capsule/roles";
import { ago, shortHex } from "@/lib/format";
import type { Capsule } from "@/lib/capsule/fleet";

/* The master override. One call — authorizeTextRoles(…, false) — and the next
   heartbeat write reverts with EACUnauthorizedAccountRoles. The runner reads
   that revert as its own stop signal. Nothing else is torn down.

   NOT WIRED YET. The wallet is connected and the fleet below is read from the
   chain, but this dialog does not yet send the transaction — that is the last
   step of the build. So it shows the exact call it will make and stops there,
   and it deliberately does NOT mark the capsule recalled afterwards. A
   dashboard that reads status from the chain must not also invent it: a
   capsule shown as recalled while its role is still granted is precisely the
   failure this project exists to make impossible. */

type Phase = "confirm" | "preview";

export default function RecallDialog({
  capsule,
  now,
  onClose,
}: {
  capsule: Capsule;
  /** The block-read time, so hydration matches the server render. */
  now: number;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [typed, setTyped] = useState("");
  const first = useRef<HTMLInputElement>(null);
  const name = capsule.name;
  const match = typed.trim() === name;

  useEffect(() => {
    first.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

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
            authorizeTextRoles()
          </span>
        </div>

        <div style={{ padding: "24px 26px 26px" }}>
          {phase === "confirm" && (
            <>
              <div className="row" style={{ gap: 16, marginBottom: 18 }}>
                <CapsuleMark size={52} cap={capColor(capsule.label)} />
                <div>
                  <div className="ensname" style={{ fontSize: 19 }}>
                    {capsule.label}
                    <span className="p">.{capsule.parent}</span>
                  </div>
                  <div className="hint">
                    {roleTitle(capsule.label)} · minted {ago(capsule.mintedAt.at, now)}
                    {capsule.lastBeat !== null && ` · last beat ${ago(capsule.lastBeat.at, now)}`}
                  </div>
                </div>
              </div>

              <p style={{ margin: "0 0 16px", fontSize: 15 }}>
                This pulls the one role the agent holds on its own name. Its next heartbeat write reverts, and the
                runner exits on that revert — within one tick, not one heartbeat.
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
                  <b style={{ fontSize: 14 }}>kept — re-granting revives it</b>
                </div>
                <div className="kv">
                  <span className="hint">Beats written so far</span>
                  <b style={{ fontSize: 14 }}>{capsule.beatCount}</b>
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
                <button className="btn btn-danger push" disabled={!match} onClick={() => setPhase("preview")}>
                  Show the call
                </button>
              </div>
            </>
          )}

          {phase === "preview" && (
            <div className="col" style={{ gap: 16, padding: "10px 0" }}>
              <div className="notice" style={{ borderColor: "var(--sun)", background: "#fff" }}>
                <span className="tag ink">Not sent</span>
                <p style={{ margin: 0 }}>
                  Signing is not wired up yet. This is the transaction the recall will send, with this capsule&rsquo;s
                  real values in it — nothing has changed on chain, and the fleet still reads as it did.
                </p>
              </div>

              <pre className="term">
                <span className="d">resolver </span>
                <span className="w">{capsule.resolver}</span>
                {"\n"}
                <span className="d">→ </span>
                <span className="w">authorizeTextRoles(</span>
                {"\n"}
                <span className="d">    dnsName </span>
                <span className="y">{name}</span>
                {"\n"}
                <span className="d">    key     </span>
                <span className="y">{RECORD_KEYS.heartbeat}</span>
                {"\n"}
                <span className="d">    account </span>
                <span className="y">{capsule.agent}</span>
                {"\n"}
                <span className="d">    granted </span>
                <span className="r">false</span>
                {"\n"}
                <span className="w">  )</span>
                {"\n\n"}
                <span className="d">then, within one tick:</span>
                {"\n"}
                <span className="d">  setText({RECORD_KEYS.heartbeat}) → </span>
                <span className="r">EACUnauthorizedAccountRoles</span>
                {"\n"}
                <span className="d">  gateway stopped · exit 0</span>
              </pre>

              <p className="hint" style={{ margin: 0 }}>
                Agent wallet {shortHex(capsule.agent, 10, 6)} holds ROLE_SET_TEXT on this key and nothing else.
              </p>

              <button className="btn btn-primary" onClick={onClose}>
                Back to the fleet
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
