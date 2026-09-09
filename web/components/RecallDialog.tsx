"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import CapsuleMark from "./Capsule";
import { CHAIN } from "@/lib/capsule/chain";
import { RECORD_KEYS } from "@/lib/capsule/records";
import {
  RecallError,
  recallCapsule,
  recallPreflight,
  type RecallPreflight,
  type RecallReceipt,
  type RecallTarget,
} from "@/lib/capsule/recall";
import { capColor, roleTitle } from "@/lib/capsule/roles";
import { shortAddress, useWallet } from "@/lib/wallet/WalletProvider";
import { ago, shortHex, txUrl } from "@/lib/format";
import type { Capsule } from "@/lib/capsule/fleet";

/* The master override. One call — authorizeTextRoles(…, false) — from the
   owner's own wallet to ENS, and the next heartbeat write reverts with
   EACUnauthorizedAccountRoles. The runner reads that revert as its own stop
   signal. Nothing else is torn down.

   Three rules this dialog keeps, in descending order of how easy they are to
   break:

   1. **It never says "recalled" until the chain has said it.** The success
      screen is drawn from a receipt whose EACRolesChanged decoded and whose
      hasRoles read back false — see recall.ts. A dashboard that reads status
      from the chain must not also invent it: a capsule shown as recalled while
      its role is still granted is precisely the failure this project exists to
      make impossible. The card behind this dialog changes because the server
      re-read the chain, not because this component decided it had.

   2. **It asks the resolver who may send, not the mint log.** `capsule.owner`
      is who owned the name at mint; the role table is who may act on it now.

   3. **It shows the call before it sends it.** The preview is not decoration —
      it is the same four arguments `buildRecallArgs()` hands to eth_call, so
      what the user reads is what the wallet is asked to sign. */

type Phase = "confirm" | "review" | "working" | "done" | "failed";

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
  const router = useRouter();
  const {
    status,
    address,
    chainOk,
    chainId,
    wallets,
    connect,
    switchChain,
    error: walletError,
    getWalletClient,
    getPublicClient,
  } = useWallet();

  const [phase, setPhase] = useState<Phase>("confirm");
  const [typed, setTyped] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<RecallReceipt | null>(null);
  const [pre, setPre] = useState<RecallPreflight | null>(null);
  const [preError, setPreError] = useState<string | null>(null);

  const first = useRef<HTMLInputElement>(null);
  const name = capsule.name;
  const match = typed.trim() === name;
  const busy = phase === "working";

  const target: RecallTarget = {
    name,
    node: capsule.node,
    resolver: capsule.resolver,
    agent: capsule.agent,
  };

  /* Escape closes, except mid-transaction: a dialog that vanishes while a
     wallet popup is open leaves the user holding a signature request for
     something they can no longer see. */
  useEffect(() => {
    first.current?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, busy]);

  /* What the resolver says about this wallet, asked as soon as the review
     screen opens and re-asked if the wallet or the chain changes underneath
     it. Two eth_calls, no gas, and it turns the two failures a user can
     actually hit — wrong wallet, already recalled — into a sentence rather
     than a rejected transaction. */
  useEffect(() => {
    if (phase !== "review" || address === null || !chainOk) return;
    const client = getPublicClient();
    if (client === null) return;
    let live = true;
    setPre(null);
    setPreError(null);
    recallPreflight(client, { name, node: capsule.node, resolver: capsule.resolver, agent: capsule.agent }, address)
      .then((result) => {
        if (live) setPre(result);
      })
      .catch((e: unknown) => {
        if (live) setPreError(e instanceof Error ? e.message : "could not read the resolver");
      });
    return () => {
      live = false;
    };
  }, [phase, address, chainOk, name, capsule.node, capsule.resolver, capsule.agent, getPublicClient]);

  const say = useCallback((line: string) => setLines((l) => [...l, line]), []);

  async function send() {
    const walletClient = getWalletClient();
    const publicClient = getPublicClient();
    if (walletClient === null || publicClient === null) {
      setPhase("failed");
      setError(`the wallet is not connected to ${CHAIN.name}`);
      return;
    }

    setPhase("working");
    setError(null);
    setLines([]);

    try {
      const result = await recallCapsule({ walletClient, publicClient, target }, (p, detail) => {
        if (p === "simulating") say("eth_call · would this revert, and would it change anything?");
        else if (p === "signing") say("no revert · sign the revoke");
        else if (p === "mining") say(`sent ${detail}`);
        else say("mined · reading the permission back");
      });
      say(`EACRolesChanged · roles ${result.oldRoles} → ${result.newRoles}`);
      say(`hasRoles(${RECORD_KEYS.heartbeat}) → false at block ${result.blockNumber}`);
      say(`${result.gasUsed.toLocaleString()} gas · ${name} keeps its subname and every record`);
      setReceipt(result);
      setPhase("done");
      // The fleet is read server-side. Refreshing re-runs that read, so what
      // the page shows next came from the chain, not from this component.
      router.refresh();
    } catch (e) {
      const message = e instanceof RecallError ? e.message : "the recall failed";
      say("✗ " + message);
      setError(message);
      setPhase("failed");
      // "Nothing to do" means the page is looking at a stale block, not that
      // the call failed. Re-read rather than leave a Recall button on a
      // capsule that no longer has a role to pull.
      if (e instanceof RecallError && e.kind === "nothing-to-do") router.refresh();
    }
  }

  const blocked =
    status !== "connected"
      ? "connect"
      : !chainOk
        ? "chain"
        : pre !== null && !pre.maySend
          ? "roles"
          : pre !== null && !pre.agentAuthorized
            ? "gone"
            : null;

  /** Nothing is known yet — the preflight is still out. */
  const checking = blocked === null && pre === null && preError === null;

  return (
    <div
      className="scrim"
      role="dialog"
      aria-modal="true"
      aria-label={"Recall " + name}
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
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
                <button className="btn btn-danger push" disabled={!match} onClick={() => setPhase("review")}>
                  Show the call
                </button>
              </div>
            </>
          )}

          {phase === "review" && (
            <div className="col" style={{ gap: 16, padding: "10px 0" }}>
              <p className="hint" style={{ margin: 0 }}>
                This is the transaction your wallet will be asked to sign, with this capsule&rsquo;s real values in it.
                It goes to the resolver, not to the minter — the kill switch does not depend on our contract existing.
              </p>

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

              {blocked === "connect" && (
                <div className="notice" style={{ borderColor: "var(--sun)", background: "#fff" }}>
                  <span className="tag ink">Wallet</span>
                  <div>
                    <p style={{ margin: "0 0 8px" }}>
                      The recall is signed by the name&rsquo;s owner. Connect that wallet to send it.
                    </p>
                    <button className="btn btn-sm btn-primary" onClick={() => void connect()}>
                      {wallets.length > 1 ? "Choose a wallet" : "Connect wallet"}
                    </button>
                    {walletError !== null && (
                      <p className="hint" style={{ margin: "8px 0 0" }}>
                        {walletError}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {blocked === "chain" && (
                <div className="notice" style={{ borderColor: "var(--sun)", background: "#fff" }}>
                  <span className="tag ink">Chain</span>
                  <div>
                    <p style={{ margin: "0 0 8px" }}>
                      This wallet is on chain {chainId ?? "?"}. The role lives on {CHAIN.name}.
                    </p>
                    <button className="btn btn-sm btn-primary" onClick={() => void switchChain()}>
                      Switch to {CHAIN.name}
                    </button>
                  </div>
                </div>
              )}

              {blocked === "roles" && (
                <div className="notice" style={{ borderColor: "var(--alarm)", background: "#fff" }}>
                  <span className="tag ink">Not the owner</span>
                  <p style={{ margin: 0 }}>
                    {address !== null && <b className="mono">{shortAddress(address)}</b>} does not hold
                    ROLE_SET_TEXT_ADMIN on {name}, so the resolver would reject this call. The name was minted to{" "}
                    <span className="mono">{shortHex(capsule.owner, 10, 6)}</span>.
                  </p>
                </div>
              )}

              {blocked === "gone" && (
                <div className="notice" style={{ borderColor: "var(--sun)", background: "#fff" }}>
                  <span className="tag ink">Already pulled</span>
                  <p style={{ margin: 0 }}>
                    The resolver says this agent holds no write role on {RECORD_KEYS.heartbeat} any more. There is
                    nothing left to revoke.
                  </p>
                </div>
              )}

              {preError !== null && (
                <p className="hint" style={{ margin: 0 }}>
                  Could not read the resolver&rsquo;s role table ({preError}). The simulation still runs before
                  anything is signed.
                </p>
              )}

              <p className="hint" style={{ margin: 0 }}>
                Agent wallet {shortHex(capsule.agent, 10, 6)} holds ROLE_SET_TEXT on this key and nothing else.
              </p>

              <div className="row" style={{ gap: 10 }}>
                <button className="btn btn-ghost" onClick={onClose}>
                  Keep it running
                </button>
                <button className="btn btn-danger push" disabled={blocked !== null || checking} onClick={() => void send()}>
                  {checking ? "Checking…" : "Pull the role"}
                </button>
              </div>
            </div>
          )}

          {(phase === "working" || phase === "done" || phase === "failed") && (
            <div className="col" style={{ gap: 16, padding: "10px 0" }}>
              {phase === "done" && (
                <div className="notice" style={{ borderColor: "var(--alarm)", background: "#fff" }}>
                  <span className="tag ink">Recalled</span>
                  <p style={{ margin: 0 }}>
                    The role is gone — and this says so because the resolver was read back after the transaction mined,
                    not because a button was pressed.
                  </p>
                </div>
              )}

              <pre className="term">
                <span className="d">resolver </span>
                <span className="w">{capsule.resolver}</span>
                {"\n"}
                <span className="d">from     </span>
                <span className="w">{address ?? "—"}</span>
                {"\n\n"}
                {lines.map((line, i) => (
                  <span
                    key={i}
                    className={line.startsWith("✗") ? "r" : i === lines.length - 1 && phase === "done" ? "g" : "d"}
                  >
                    {line}
                    {"\n"}
                  </span>
                ))}
                {busy && <span className="caret" />}
              </pre>

              {receipt !== null && (
                <div className="panel flat shell" style={{ padding: "14px 18px" }}>
                  <div className="kv">
                    <span className="hint">Transaction</span>
                    <Link
                      href={txUrl(receipt.hash)}
                      target="_blank"
                      rel="noreferrer"
                      className="mono"
                      style={{ fontSize: 13 }}
                    >
                      {shortHex(receipt.hash, 10, 8)}
                    </Link>
                  </div>
                  <div className="kv">
                    <span className="hint">Block</span>
                    <b style={{ fontSize: 14 }}>{receipt.blockNumber.toString()}</b>
                  </div>
                  <div className="kv">
                    <span className="hint">Gas</span>
                    <b style={{ fontSize: 14 }}>{receipt.gasUsed.toLocaleString()}</b>
                  </div>
                  <div className="kv">
                    <span className="hint">Still yours</span>
                    <b style={{ fontSize: 14 }}>the subname, the records, the secrets</b>
                  </div>
                </div>
              )}

              {phase === "failed" && error !== null && (
                <div className="notice" style={{ borderColor: "var(--alarm)", background: "#fff" }}>
                  <span className="tag ink">Not sent</span>
                  <p style={{ margin: 0 }}>{error}. Nothing changed on chain, and the fleet still reads as it did.</p>
                </div>
              )}

              {!busy && (
                <div className="row" style={{ gap: 10 }}>
                  {phase === "failed" && (
                    <button className="btn btn-ghost" onClick={() => setPhase("review")}>
                      Back to the call
                    </button>
                  )}
                  <button className="btn btn-primary push" onClick={onClose}>
                    Back to the fleet
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
