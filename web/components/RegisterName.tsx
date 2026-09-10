"use client";

/* ------------------------------------------------------------------
   Buy a name.

   The step before /connect, and the one the hackathon deployment's own app
   cannot complete: it prices registration in a token it gives you no way to
   obtain. That token has an open `mint`, so what was missing was a button.

   Same shape as /connect deliberately — a checklist, not a wizard. Every row is
   a fact read off Sepolia and the button beside it is the transaction that makes
   the fact true. Registration is two transactions with a mandatory sixty-second
   gap, so being interrupted between them is the normal case; a page that
   remembers nothing shows a returning user where they actually are.

   The one thing it does remember is the commitment secret, and it has to —
   see lib/capsule/register.ts.
   ------------------------------------------------------------------ */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import Capsule from "@/components/Capsule";
import { CHAIN, PAYMENT_TOKENS, type PaymentToken } from "@/lib/capsule/chain";
import {
  DEFAULT_DURATION,
  DURATIONS,
  RegisterError,
  approvePayment,
  commitName,
  commitmentExpired,
  formatAmount,
  fullName,
  labelProblems,
  mintTestTokens,
  readRegistration,
  registerName,
  secondsUntilReveal,
  type RegisterStatus,
} from "@/lib/capsule/register";
import { shortAddress, useWallet } from "@/lib/wallet/WalletProvider";
import { duration as humanDuration, shortHex, txUrl } from "@/lib/format";

type Busy = null | { step: string; detail?: string };

export default function RegisterName({ initialLabel = "" }: { initialLabel?: string }) {
  const { address, chainOk, status, getWalletClient, getPublicClient, switchChain } = useWallet();
  const connected = status === "connected" && address !== null;

  const [raw, setRaw] = useState(initialLabel.trim().toLowerCase());
  const [duration, setDuration] = useState<number>(DEFAULT_DURATION);
  const [token, setToken] = useState<PaymentToken>(PAYMENT_TOKENS[0]);
  const [checked, setChecked] = useState<RegisterStatus | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<{ text: string; tx?: string }[]>([]);
  const [bought, setBought] = useState<string | null>(null);

  /* The chain's clock, carried forward locally.

     The registrar compares the commitment age against the block timestamp, not
     against the visitor's system clock, and the two can differ by a lot more
     than the sixty seconds being counted. So the countdown starts from the
     timestamp of the block the status was read at and advances with a local
     ticker, which is accurate enough for a progress bar and never claims the
     wait is over before the chain agrees. */
  const readAt = useRef<number>(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const label = raw.trim().toLowerCase();
  const problems = raw.trim() === "" ? [] : labelProblems(raw);
  const labelOk = label !== "" && problems.length === 0;

  const say = useCallback((text: string, tx?: string) => {
    setLog((entries) => [...entries, { text, tx }]);
  }, []);

  const refresh = useCallback(async () => {
    if (!connected || !labelOk) return;
    const publicClient = getPublicClient();
    if (publicClient === null) return;
    setReading(true);
    setError(null);
    try {
      const next = await readRegistration({
        publicClient,
        owner: address as Address,
        label,
        duration,
        token,
      });
      readAt.current = Date.now();
      setChecked(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not read this name on chain");
      setChecked(null);
    } finally {
      setReading(false);
    }
  }, [connected, labelOk, label, duration, token, address, getPublicClient]);

  /* Duration and token are both inputs to what is on screen — duration changes
     the price and the commitment, token changes the price, the balance and the
     allowance — so a checked name is re-read rather than left showing numbers
     for settings the user has since changed. */
  useEffect(() => {
    if (checked !== null) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, duration, token]);

  /* A label arriving from /connect has already been typed once and found
     missing, so the handoff should land on an answered page rather than a
     pre-filled form waiting for the same button to be pressed again. Fires once,
     as soon as a wallet is available to read with. */
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || initialLabel === "" || !connected || !chainOk) return;
    if (labelProblems(initialLabel).length > 0) return;
    prefilled.current = true;
    void refresh();
  }, [initialLabel, connected, chainOk, refresh]);

  const run = useCallback(
    async (step: string, fn: (clients: { walletClient: never; publicClient: never }) => Promise<void>) => {
      const walletClient = getWalletClient();
      const publicClient = getPublicClient();
      if (walletClient === null || publicClient === null) {
        setError("connect a wallet on " + CHAIN.name + " first");
        return;
      }
      setError(null);
      setBusy({ step });
      try {
        await fn({ walletClient, publicClient } as never);
        await refresh();
      } catch (e) {
        if (e instanceof RegisterError && e.kind === "rejected") setError(null);
        else setError(e instanceof Error ? e.message : "the transaction failed");
      } finally {
        setBusy(null);
      }
    },
    [getWalletClient, getPublicClient, refresh],
  );

  const phase = (step: string) => (p: string, detail?: string) =>
    setBusy({ step, detail: `${p}${detail ? ` · ${shortHex(detail)}` : ""}` });

  /* ---------------- derived facts ---------------- */

  const total = checked?.price?.total ?? null;
  const unit = 10n ** BigInt(token.decimals);
  const shortfall = checked !== null && total !== null && checked.balance < total ? total - checked.balance : 0n;
  // Whole units plus a two-unit buffer, so the button reads "Mint 10 test USDC"
  // rather than "Mint 8.000021 test USDC" and a second year does not need a
  // second trip to the faucet.
  const faucetAmount = ((shortfall + unit - 1n) / unit + 2n) * unit;

  const funded = checked !== null && total !== null && checked.balance >= total;
  const approved = checked !== null && total !== null && checked.allowance >= total;

  const chainNow = checked === null ? 0 : checked.chainNow + Math.floor((Date.now() - readAt.current) / 1000);
  void tick; // the ticker exists to re-render this line every second
  const waiting = checked === null ? null : secondsUntilReveal(checked, chainNow);
  const expired = checked !== null && commitmentExpired(checked, chainNow);
  const committed = checked !== null && checked.committedAt !== 0 && !expired;
  const revealable = committed && waiting === 0;

  /* ---------------- the four actions ---------------- */

  const onMint = () =>
    run(`Minting ${token.label}`, async ({ walletClient, publicClient }) => {
      const hash = await mintTestTokens(
        { walletClient, publicClient, token, to: address as Address, amount: faucetAmount },
        phase(`Minting ${token.label}`),
      );
      say(`minted ${formatAmount(faucetAmount, token)} ${token.symbol}`, hash);
    });

  const onApprove = () =>
    run("Approving", async ({ walletClient, publicClient }) => {
      if (total === null) return;
      const hash = await approvePayment(
        { walletClient, publicClient, token, amount: total },
        phase("Approving"),
      );
      say(`the registrar may take ${formatAmount(total, token)} ${token.symbol}`, hash);
    });

  const onCommit = () =>
    run("Committing", async ({ walletClient, publicClient }) => {
      const { hash } = await commitName(
        { walletClient, publicClient, owner: address as Address, label, duration },
        phase("Committing"),
      );
      say(`committed to ${fullName(label)} — the reveal opens in a minute`, hash);
    });

  const onRegister = () =>
    run("Registering", async ({ walletClient, publicClient }) => {
      const hash = await registerName(
        { walletClient, publicClient, owner: address as Address, label, duration, token },
        phase("Registering"),
      );
      setBought(fullName(label));
      say(`${fullName(label)} is registered to ${shortAddress(address as Address)}`, hash);
    });

  const durationLabel = DURATIONS.find((d) => d.seconds === duration)?.label ?? humanDuration(duration);

  return (
    <div className="stack" style={{ gap: 22 }}>
      <div className="panel pad-lg">
        <div className="stepline">
          <span className="stepnum">01</span>
          <span className="tag">Your name</span>
        </div>
        <p className="stitle">Register a name on the ENSv2 beta</p>
        <p className="ssub">
          Capsule launches agents as subnames, so everything starts with a name you own. This registers one
          directly against the beta&rsquo;s <span className="mono">ETHRegistrar</span> — no app in between — and
          hands you the test token to pay with. Then take it to{" "}
          <Link href="/connect">Connect a name</Link>.
        </p>

        <div className="field" style={{ maxWidth: 460 }}>
          <label className="label" htmlFor="label">
            Name
          </label>
          <div className="row" style={{ gap: 10, alignItems: "center" }}>
            <input
              id="label"
              className="input mono"
              placeholder="yourname"
              value={raw}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => {
                setRaw(e.target.value.toLowerCase());
                setChecked(null);
                setBought(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && labelOk) void refresh();
              }}
            />
            <span className="mono hint" style={{ flex: "none" }}>
              .eth
            </span>
          </div>
          {problems.map((p) => (
            <span key={p} className="hint" style={{ color: "var(--alarm)" }}>
              {p}
            </span>
          ))}
        </div>

        <div className="row wrapflex" style={{ gap: 18, marginTop: 16, alignItems: "flex-end" }}>
          <div className="field" style={{ maxWidth: 200 }}>
            <label className="label" htmlFor="duration">
              For
            </label>
            <select
              id="duration"
              className="select"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              {DURATIONS.map((d) => (
                <option key={d.seconds} value={d.seconds}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ maxWidth: 260 }}>
            <label className="label" htmlFor="token">
              Paid in
            </label>
            <select
              id="token"
              className="select"
              value={token.address}
              onChange={(e) => {
                const next = PAYMENT_TOKENS.find((t) => t.address === e.target.value);
                if (next !== undefined) setToken(next);
              }}
            >
              {PAYMENT_TOKENS.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.label}
                </option>
              ))}
            </select>
            <span className="hint">{token.note}</span>
          </div>
        </div>

        <div className="row wrapflex" style={{ gap: 10, marginTop: 16 }}>
          {!connected ? (
            <span className="hint">Connect a wallet to check a name.</span>
          ) : !chainOk ? (
            <button className="btn btn-sun" onClick={() => void switchChain()}>
              Switch to {CHAIN.name}
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={!labelOk || reading}
              onClick={() => void refresh()}
            >
              {reading ? "Reading the chain…" : "Check this name"}
            </button>
          )}
        </div>
      </div>

      {error !== null && (
        <div className="panel pad" style={{ borderColor: "var(--alarm)" }}>
          <strong>Could not do that.</strong>
          <div className="hint" style={{ marginTop: 6 }}>
            {error}
          </div>
        </div>
      )}

      {checked !== null && (
        <div className="panel pad-lg">
          <div className="stepline">
            <span className="stepnum">02</span>
            <span className="tag">Buy it</span>
          </div>
          <p className="stitle">{checked.name}</p>
          <p className="ssub">
            Read from Sepolia, not remembered. Registration is commit then reveal, sixty seconds apart — that gap is
            what stops somebody reading your name out of the mempool and taking it first.
          </p>

          {checked.ownerHasCode && (
            <div className="notice" style={{ marginTop: 14, borderColor: "var(--alarm)" }}>
              <strong>This wallet probably cannot hold the name.</strong>
              <p className="hint" style={{ marginTop: 6 }}>
                A <span className="mono">.eth</span> name is an ERC-1155 token, and{" "}
                {shortAddress(address as Address)} has code at its address — a smart account, or an EOA that has
                delegated under EIP-7702. The registry mints with an acceptance check, so unless that code
                implements <span className="mono">onERC1155Received</span> the final transaction reverts after
                you have already paid for a commitment. Register from a plain EOA and transfer the name afterwards
                if you need it somewhere else.
              </p>
            </div>
          )}

          <Row
            done={checked.available}
            title="Available"
            detail={
              checked.available
                ? `nobody holds ${checked.name} — it is yours to take`
                : `${checked.name} is already registered`
            }
          />

          {!checked.available && bought === null && (
            <div className="notice" style={{ marginTop: 14 }}>
              <strong>Somebody holds {checked.name} already.</strong>
              <p className="hint" style={{ marginTop: 6 }}>
                Possibly you — this page reads the registrar, not your wallet, and a name you bought a minute ago
                looks exactly like a name somebody else bought last week. If it is yours,{" "}
                <Link href="/connect">Connect a name</Link> will tell you what it still needs. If it is not, try
                another label.
              </p>
            </div>
          )}

          {checked.price === null ? (
            <div className="notice" style={{ marginTop: 14 }}>
              <strong>The registrar will not price that name.</strong>
              <p className="hint" style={{ marginTop: 6 }}>
                Its price oracle rejects labels it considers invalid — too short, or characters it will not sell.
                Try another.
              </p>
            </div>
          ) : (
            <>
              <div className="tile" style={{ marginTop: 16 }}>
                <div className="spread" style={{ alignItems: "baseline", gap: 16 }}>
                  <div>
                    <strong>
                      {formatAmount(checked.price.total, token)} {token.symbol}
                    </strong>
                    <p className="hint" style={{ marginTop: 4 }}>
                      for {durationLabel}
                      {checked.price.premium > 0n
                        ? ` · includes a ${formatAmount(checked.price.premium, token)} ${token.symbol} release premium`
                        : ""}
                    </p>
                  </div>
                  <span className="push hint mono">
                    you hold {formatAmount(checked.balance, token)} {token.symbol}
                  </span>
                </div>
              </div>

              <Row
                done={funded}
                title={`Enough ${token.label}`}
                detail={
                  funded
                    ? "your balance covers the fee"
                    : token.mintable
                      ? `short by ${formatAmount(shortfall, token)} ${token.symbol} — this token has an open mint, so take some`
                      : `short by ${formatAmount(shortfall, token)} ${token.symbol} — real USDC cannot be minted, so it comes from Circle's faucet. The test token above buys an identical name if you would rather not wait.`
                }
              >
                {!funded && token.mintable && (
                  <button className="btn btn-sm btn-sun" disabled={busy !== null} onClick={onMint}>
                    Mint {formatAmount(faucetAmount, token)} {token.symbol}
                  </button>
                )}
                {!funded && !token.mintable && token.faucet !== undefined && (
                  <a className="btn btn-sm btn-sun" href={token.faucet} target="_blank" rel="noreferrer">
                    Open the faucet
                  </a>
                )}
              </Row>

              <Row
                done={approved}
                title="Registrar approved"
                detail={
                  approved
                    ? `it may take exactly ${formatAmount(checked.price.total, token)} ${token.symbol}, and no more`
                    : "the registrar pulls the fee during register(), so it needs an allowance first"
                }
              >
                {!approved && (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy !== null || !funded}
                    onClick={onApprove}
                  >
                    Approve
                  </button>
                )}
              </Row>

              <Row
                done={committed}
                title="Committed"
                detail={
                  expired
                    ? "your commitment aged out — commit again, the name is still free"
                    : !committed
                      ? "puts a hash of your name on chain, revealing nothing"
                      : waiting !== null && waiting > 0
                        ? `revealed in ${waiting}s`
                        : "ready to reveal"
                }
              >
                {(!committed || expired) && (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy !== null || !checked.available || !approved}
                    onClick={onCommit}
                  >
                    Commit
                  </button>
                )}
              </Row>

              <Row
                done={bought !== null}
                title="Registered"
                detail={
                  bought !== null
                    ? `${bought} belongs to ${shortAddress(address as Address)}`
                    : "reveals the name and pays the fee in one transaction"
                }
              >
                {bought === null && (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy !== null || !revealable || !checked.available}
                    onClick={onRegister}
                  >
                    {committed && waiting !== null && waiting > 0 ? `Wait ${waiting}s` : "Register"}
                  </button>
                )}
              </Row>
            </>
          )}

          {busy !== null && (
            <div className="hint" style={{ marginTop: 16 }}>
              {busy.step}
              {busy.detail === undefined ? "…" : ` · ${busy.detail}`}
            </div>
          )}

          {bought !== null && (
            <div className="notice" style={{ marginTop: 20, borderColor: "var(--mint-700)" }}>
              <strong>{bought} is yours.</strong>
              <p className="hint" style={{ marginTop: 6 }}>
                It has no subregistry and no resolver yet — both were left unset on purpose, and both are set
                afterwards. <Link href="/connect">Connect a name</Link> reads the name, tells you exactly what it
                still needs, and sends the transactions that give it to it. Once it is connected, every agent you
                launch lands at <span className="mono">{`<role>.${bought}`}</span>.
              </p>
              <div className="row" style={{ gap: 10, marginTop: 12 }}>
                <Link className="btn btn-sm btn-primary" href={`/connect?name=${encodeURIComponent(bought)}`}>
                  Set it up for Capsule
                </Link>
              </div>
            </div>
          )}
        </div>
      )}

      {log.length > 0 && (
        <div className="panel pad">
          <strong>What happened</strong>
          <div className="stack" style={{ gap: 8, marginTop: 10 }}>
            {log.map((entry, i) => (
              <div key={i} className="hint" style={{ display: "flex", gap: 10 }}>
                <Capsule size={14} />
                <span>{entry.text}</span>
                {entry.tx !== undefined && (
                  <a className="mono" href={txUrl(entry.tx)} target="_blank" rel="noreferrer">
                    {shortHex(entry.tx)}
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  done,
  title,
  detail,
  children,
}: {
  done: boolean;
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="dashrow" style={{ alignItems: "flex-start", gap: 14 }}>
      <span
        className={"pill " + (done ? "run" : "quiet")}
        style={{ flex: "none", marginTop: 2 }}
        aria-label={done ? "done" : "not yet"}
      >
        <span className="led" />
        {done ? "yes" : "no"}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 700 }}>{title}</div>
        <div className="hint" style={{ marginTop: 3 }}>
          {detail}
        </div>
      </div>
      <span className="push">{children}</span>
    </div>
  );
}
