"use client";

import { useEffect, useRef, useState } from "react";
import { CHAIN } from "@/lib/capsule/chain";
import { shortAddress, useWallet } from "@/lib/wallet/WalletProvider";

/* The wallet control in the nav. Four states, and the wrong-chain one is
   not a detail: every Capsule write is a Sepolia write, so a wallet on
   another chain is shown as a problem to fix, never as connected. */

export default function ConnectButton() {
  const { status, address, chainOk, chainId, walletName, wallets, connect, disconnect, switchChain, error } =
    useWallet();
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!picking && !menu) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        setPicking(false);
        setMenu(false);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPicking(false);
        setMenu(false);
      }
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [picking, menu]);

  function onConnectClick() {
    if (wallets.length === 1) void connect(wallets[0]!.info.rdns);
    else setPicking((p) => !p);
  }

  /* ---------- connected ---------- */
  if (status === "connected" && address !== null) {
    return (
      <div ref={box} style={{ marginLeft: "auto", position: "relative" }}>
        {!chainOk && (
          <button
            className="btn btn-sm btn-danger"
            style={{ marginRight: 8 }}
            onClick={() => void switchChain()}
            title={`Connected to chain ${chainId ?? "?"} — Capsule writes to ${CHAIN.name}`}
          >
            Switch to {CHAIN.name}
          </button>
        )}
        <button
          className="wallet"
          style={{ marginLeft: 0, cursor: "pointer", font: "inherit", fontSize: 12, fontWeight: 600 }}
          onClick={() => setMenu((m) => !m)}
          aria-expanded={menu}
          title={walletName ?? "Connected"}
        >
          <span className="dot" style={{ background: chainOk ? "var(--mint)" : "var(--sun)" }} />
          <span>{shortAddress(address)}</span>
          <span style={{ opacity: 0.6 }}>{chainOk ? CHAIN.name : "wrong chain"}</span>
        </button>

        {menu && (
          <div className="panel" style={dropdown}>
            <div className="label" style={{ marginBottom: 8 }}>
              {walletName ?? "Wallet"}
            </div>
            <div className="mono" style={{ fontSize: 11.5, wordBreak: "break-all", marginBottom: 12 }}>
              {address}
            </div>
            <button
              className="btn btn-sm btn-ghost btn-block"
              onClick={() => {
                disconnect();
                setMenu(false);
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  /* ---------- connecting / disconnected ---------- */
  return (
    <div ref={box} style={{ marginLeft: "auto", position: "relative" }}>
      <button className="btn btn-sm btn-primary" onClick={onConnectClick} disabled={status === "connecting"}>
        {status === "connecting" ? "Connecting…" : "Connect wallet"}
      </button>

      {picking && (
        <div className="panel" style={dropdown}>
          <div className="label" style={{ marginBottom: 10 }}>
            {wallets.length === 0 ? "No wallet found" : "Choose a wallet"}
          </div>

          {wallets.length === 0 ? (
            <p className="hint" style={{ margin: 0, maxWidth: 220 }}>
              No EIP-1193 wallet is installed in this browser. Install MetaMask, Rabby or another
              wallet and reload.
            </p>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {wallets.map((w) => (
                <button
                  key={w.info.rdns}
                  className="btn btn-sm btn-ghost"
                  style={{ justifyContent: "flex-start", gap: 10, display: "flex", alignItems: "center" }}
                  onClick={() => {
                    setPicking(false);
                    void connect(w.info.rdns);
                  }}
                >
                  {w.info.icon !== "" && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={w.info.icon} alt="" width={18} height={18} style={{ borderRadius: 4 }} />
                  )}
                  {w.info.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error !== null && (
        <div className="panel" style={{ ...dropdown, borderColor: "var(--alarm)" }}>
          <p className="hint" style={{ margin: 0, maxWidth: 240, color: "var(--alarm)" }}>
            {error}
          </p>
        </div>
      )}
    </div>
  );
}

const dropdown: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 10px)",
  right: 0,
  zIndex: 60,
  background: "#fff",
  padding: "14px 16px",
  minWidth: 210,
};
