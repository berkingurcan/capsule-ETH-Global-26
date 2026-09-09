"use client";

/* ------------------------------------------------------------------
   Bring your own name.

   Four checks, four buttons, in the order the chain requires them. The page is
   deliberately a checklist rather than a wizard: every row is a fact read off
   Sepolia, and the button next to a row is the transaction that makes that fact
   true. Reload it at any point and it shows where you actually are, because it
   never remembers anything — `readParentStatus` is the only source of truth on
   the screen.

   That matters more here than on the launch form. Connecting is four
   transactions from a wallet that may be interrupted between any two of them,
   and a wizard holding step state in React would happily ask someone to deploy a
   second resolver because it forgot they had one.

   The one step this page cannot perform is the first, and it says so: a `.eth`
   name on the ENSv2 beta has no subregistry until its owner deploys one, and
   that is an ENS operation, not a Capsule one.
   ------------------------------------------------------------------ */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import Capsule from "@/components/Capsule";
import { CHAIN } from "@/lib/capsule/chain";
import {
  ConnectError,
  connectParent,
  deployResolver,
  grantRegistrar,
  grantResolverRoles,
  setParentOpen,
} from "@/lib/capsule/connect";
import {
  encodeParent,
  parentNameProblems,
  readParentStatus,
  type ParentStatus,
} from "@/lib/capsule/parent";
import { shortAddress, useWallet } from "@/lib/wallet/WalletProvider";
import { shortHex, txUrl } from "@/lib/format";

/** Where a user without a subregistry has to go. The hackathon deployment's own app. */
const ENS_MANAGER = "https://hackathon-deployment-manager-app-v4.ens-cf.workers.dev/";

type Busy = null | { step: string; detail?: string };

export default function ConnectName({ minter }: { minter: string | null }) {
  const { address, chainOk, status, getWalletClient, getPublicClient, switchChain } = useWallet();
  const connected = status === "connected" && address !== null;

  const [raw, setRaw] = useState("");
  const [checked, setChecked] = useState<ParentStatus | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<{ text: string; tx?: string }[]>([]);
  const [open, setOpen] = useState(false);
  /** The resolver this session deployed, or one the user pasted after a reload. */
  const [freshResolver, setFreshResolver] = useState<Address | null>(null);

  const problems = raw.trim() === "" ? [] : parentNameProblems(raw);
  const nameOk = raw.trim() !== "" && problems.length === 0;

  const say = useCallback((text: string, tx?: string) => {
    setLog((entries) => [...entries, { text, tx }]);
  }, []);

  /* One read, re-run after every transaction. Everything on screen derives from
     it, so a step that silently failed cannot leave the page claiming success. */
  const refresh = useCallback(async () => {
    if (!connected || !nameOk || minter === null) return;
    const publicClient = getPublicClient();
    if (publicClient === null) return;
    setReading(true);
    setError(null);
    try {
      const status = await readParentStatus(
        publicClient,
        minter as Address,
        encodeParent(raw),
        address as Address,
      );
      setChecked(status);
      setOpen(status.open);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not read this name on chain");
      setChecked(null);
    } finally {
      setReading(false);
    }
  }, [connected, nameOk, minter, raw, address, getPublicClient]);

  // Re-read when the wallet changes underneath a checked name. An address switch
  // changes the answer to "may this account mint here" without changing the name.
  useEffect(() => {
    if (checked !== null) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const run = useCallback(
    async (label: string, fn: (clients: { walletClient: never; publicClient: never }) => Promise<void>) => {
      const walletClient = getWalletClient();
      const publicClient = getPublicClient();
      if (walletClient === null || publicClient === null) {
        setError("connect a wallet on " + CHAIN.name + " first");
        return;
      }
      setError(null);
      setBusy({ step: label });
      try {
        await fn({ walletClient, publicClient } as never);
        await refresh();
      } catch (e) {
        if (e instanceof ConnectError && e.kind === "rejected") setError(null);
        else setError(e instanceof Error ? e.message : "the transaction failed");
      } finally {
        setBusy(null);
      }
    },
    [getWalletClient, getPublicClient, refresh],
  );

  const phase = (step: string) => (p: string, detail?: string) => setBusy({ step, detail: `${p}${detail ? ` · ${shortHex(detail)}` : ""}` });

  /* ---------------- the four actions ---------------- */

  const onDeployResolver = () =>
    run("Deploying resolver", async ({ walletClient, publicClient }) => {
      const { hash, resolver } = await deployResolver(
        { walletClient, publicClient, admin: address as Address },
        phase("Deploying resolver"),
      );
      setFreshResolver(resolver);
      say(`resolver deployed at ${shortAddress(resolver)}`, hash);
    });

  const onGrantRegistrar = () =>
    run("Granting ROLE_REGISTRAR", async ({ walletClient, publicClient }) => {
      const hash = await grantRegistrar(
        {
          walletClient,
          publicClient,
          registry: checked!.registry as Address,
          minter: minter as Address,
        },
        phase("Granting ROLE_REGISTRAR"),
      );
      say("the minter may now register subnames under this name", hash);
    });

  const onGrantResolver = () =>
    run("Granting resolver roles", async ({ walletClient, publicClient }) => {
      const resolver = resolverToUse;
      if (resolver === null) {
        setError("deploy a resolver first, or paste the address of one you already have");
        return;
      }
      const hash = await grantResolverRoles(
        { walletClient, publicClient, resolver, minter: minter as Address },
        phase("Granting resolver roles"),
      );
      say("the minter may now write records under this name", hash);
    });

  const onConnect = () =>
    run("Connecting", async ({ walletClient, publicClient }) => {
      const resolver = resolverToUse;
      if (resolver === null) {
        setError("a resolver is required before connecting");
        return;
      }
      const hash = await connectParent(
        {
          walletClient,
          publicClient,
          minter: minter as Address,
          registry: checked!.registry as Address,
          resolver,
          parent: encodeParent(raw),
          open,
        },
        phase("Connecting"),
      );
      say(`${encodeParent(raw).name} is connected to Capsule`, hash);
    });

  const onToggleOpen = (next: boolean) =>
    run(next ? "Opening" : "Closing", async ({ walletClient, publicClient }) => {
      const hash = await setParentOpen(
        {
          walletClient,
          publicClient,
          minter: minter as Address,
          registry: checked!.registry as Address,
          open: next,
        },
        phase(next ? "Opening" : "Closing"),
      );
      say(next ? "anyone may now mint here" : "only your admins may mint here", hash);
    });

  const zero = "0x0000000000000000000000000000000000000000";
  const hasSubregistry = checked !== null && checked.registry !== null;

  /* Which resolver the two grants and the connect will point at.

     Once connected, the minter's stored one, always. Changing a connected name's
     resolver from this screen is how you end up granting roles on a resolver
     nothing resolves through — it is a real operation, but it belongs behind a
     deliberate "change my resolver" flow, not behind the field someone is using
     to finish their first setup.

     Before that, whatever this session just deployed. That is held in state and
     therefore lost on reload, which is why the field below is editable: the proxy
     address is deterministic in (factory, wallet, salt), so a reloaded user has a
     resolver they cannot see, and asking them to paste it is better than
     silently deploying a second one they also pay for. */
  const storedResolver =
    checked?.connected && checked.resolver !== zero ? (checked.resolver as Address) : null;
  const resolverToUse: Address | null = storedResolver ?? freshResolver;
  const hasResolver = resolverToUse !== null && resolverToUse !== zero;

  return (
    <div className="stack" style={{ gap: 22 }}>
      <div className="panel pad-lg">
        <div className="stepline">
          <span className="stepnum">01</span>
          <span className="tag">Your name</span>
        </div>
        <p className="stitle">Connect a name you own</p>
        <p className="ssub">
          Capsule mints an agent as a subname. Point it at any <span className="mono">.eth</span> name you control
          and every agent you launch lands under that name — <span className="mono">dev.yourname.eth</span>,{" "}
          <span className="mono">trader.yourname.eth</span>. Connecting grants two ENS roles you can revoke at any
          time; Capsule never holds your name.
        </p>

        <div className="field" style={{ maxWidth: 460 }}>
          <label className="label" htmlFor="parent">
            Parent name
          </label>
          <input
            id="parent"
            className="input mono"
            placeholder="yourname.eth"
            value={raw}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              setRaw(e.target.value.toLowerCase());
              setChecked(null);
              // A resolver deployed for one name must not carry over to the next:
              // granting roles on it would be a real transaction against the wrong
              // contract, and it would look like it worked.
              setFreshResolver(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && nameOk) void refresh();
            }}
          />
          {problems.map((p) => (
            <span key={p} className="hint" style={{ color: "var(--alarm)" }}>
              {p}
            </span>
          ))}
        </div>

        <div className="row wrapflex" style={{ gap: 10, marginTop: 16 }}>
          {!connected ? (
            <span className="hint">Connect a wallet to check this name.</span>
          ) : !chainOk ? (
            <button className="btn btn-sun" onClick={() => void switchChain()}>
              Switch to {CHAIN.name}
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={!nameOk || reading || minter === null}
              onClick={() => void refresh()}
            >
              {reading ? "Reading the chain…" : "Check this name"}
            </button>
          )}
          {minter === null && (
            <span className="hint" style={{ color: "var(--alarm)" }}>
              CAPSULE_MINTER_ADDRESS is unset, so this page cannot check anything.
            </span>
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
            <span className="tag">Setup</span>
          </div>
          <p className="stitle">{checked.parent.name}</p>
          <p className="ssub">
            Everything below is read from Sepolia, not remembered. Each row is a fact; the button next to it is the
            transaction that makes the fact true.
          </p>

          {/* --- 0. the subregistry, which this page cannot create --- */}
          <Row
            done={hasSubregistry}
            title="Has a subregistry"
            detail={
              hasSubregistry
                ? `${shortAddress(checked.registry as Address)} issues this name's subnames`
                : "this name cannot issue subnames to anyone yet"
            }
          >
            {!hasSubregistry && (
              <a className="btn btn-sm btn-sun" href={ENS_MANAGER} target="_blank" rel="noreferrer">
                Open the ENS manager
              </a>
            )}
          </Row>

          {!hasSubregistry && (
            <div className="notice" style={{ marginTop: 14 }}>
              <strong>This one step is ENS&rsquo;s, not ours.</strong>
              <p className="hint" style={{ marginTop: 6 }}>
                A name registered on the ENSv2 beta has no subregistry until its owner deploys one and links it in
                both directions. Until that exists, nothing can create <span className="mono">{`x.${checked.parent.name}`}</span>{" "}
                — not Capsule, not the ENS app, not you. Create the subregistry in the ENS manager, then come back
                and check the name again.
              </p>
            </div>
          )}

          {hasSubregistry && (
            <>
              {/* --- 1. a resolver of its own --- */}
              <Row
                done={hasResolver}
                title="Has a PermissionedResolver"
                detail={
                  hasResolver
                    ? `records will be written to ${shortAddress(resolverToUse as Address)}`
                    : "ENSv2 names need one of these before records can be authorized"
                }
              >
                {!hasResolver && (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy !== null || !checked.callerIsAdmin}
                    onClick={onDeployResolver}
                  >
                    Deploy one
                  </button>
                )}
              </Row>

              {!storedResolver && (
                <details style={{ marginTop: 8 }}>
                  <summary className="hint" style={{ cursor: "pointer" }}>
                    I already have a resolver for this name
                  </summary>
                  <div className="field" style={{ maxWidth: 460, marginTop: 10 }}>
                    <input
                      className="input mono"
                      placeholder="0x… the PermissionedResolver for this name"
                      value={freshResolver ?? ""}
                      spellCheck={false}
                      onChange={(e) => {
                        const value = e.target.value.trim();
                        setFreshResolver(/^0x[0-9a-fA-F]{40}$/.test(value) ? (value as Address) : null);
                      }}
                    />
                    <span className="hint">
                      Deploying is deterministic in your wallet address, so the one this page would create is
                      always the same — paste an existing one here rather than paying for a second.
                    </span>
                  </div>
                </details>
              )}

              {/* --- 2 and 3. the two grants --- */}
              <Row
                done={checked.registrarGranted}
                title="Capsule may register subnames"
                detail="ROLE_REGISTRAR on your registry — revoke it and Capsule can never mint here again"
              >
                {!checked.registrarGranted && (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy !== null || !checked.callerIsAdmin}
                    onClick={onGrantRegistrar}
                  >
                    Grant
                  </button>
                )}
              </Row>

              <Row
                done={checked.resolverRolesGranted}
                title="Capsule may write records"
                detail="four root roles on your resolver — the same ones it uses to hand you the kill switch"
              >
                {!checked.resolverRolesGranted && (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy !== null || !hasResolver || !checked.callerIsAdmin}
                    onClick={onGrantResolver}
                  >
                    Grant
                  </button>
                )}
              </Row>

              {/* --- 4. record it --- */}
              <Row
                done={checked.connected}
                title="Registered with the minter"
                detail={
                  checked.connected
                    ? `node ${shortHex(checked.node)}`
                    : "stores your resolver against your registry so mint() takes only a registry"
                }
              >
                {!checked.connected && (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy !== null || !hasResolver || !checked.callerIsAdmin}
                    onClick={onConnect}
                  >
                    Connect
                  </button>
                )}
              </Row>

              {!checked.callerIsAdmin && (
                <div className="notice" style={{ marginTop: 14 }}>
                  <strong>This wallet cannot configure {checked.parent.name}.</strong>
                  <p className="hint" style={{ marginTop: 6 }}>
                    Connecting requires <span className="mono">ROLE_REGISTRAR_ADMIN</span> on the name&rsquo;s
                    registry — held by whoever deployed it. {shortAddress(address as Address)} does not have it.
                    Switch to the wallet that owns this name.
                  </p>
                </div>
              )}

              {/* --- who may mint, once it is connected --- */}
              {checked.connected && (
                <div className="tile" style={{ marginTop: 20 }}>
                  <div className="spread" style={{ alignItems: "flex-start", gap: 16 }}>
                    <div style={{ minWidth: 0 }}>
                      <strong>Who may launch agents here</strong>
                      <p className="hint" style={{ marginTop: 6, maxWidth: "60ch" }}>
                        {checked.open
                          ? "Anyone. Good for a demo people are invited to try; it also means anyone can take a label under your name."
                          : "Only wallets that administer this name's registry. Anyone else gets a refusal from the contract, not from us."}
                      </p>
                    </div>
                    <span className="push">
                      <button
                        className={"btn btn-sm " + (checked.open ? "btn-ghost" : "btn-sun")}
                        disabled={busy !== null || !checked.callerIsAdmin}
                        onClick={() => onToggleOpen(!checked.open)}
                      >
                        {checked.open ? "Close to outsiders" : "Open to anyone"}
                      </button>
                    </span>
                  </div>
                </div>
              )}
            </>
          )}

          {busy !== null && (
            <div className="hint" style={{ marginTop: 16 }}>
              {busy.step}
              {busy.detail === undefined ? "…" : ` · ${busy.detail}`}
            </div>
          )}

          {checked.callerMayMint && (
            <div className="notice" style={{ marginTop: 20, borderColor: "var(--mint-700)" }}>
              <strong>{checked.parent.name} is ready.</strong>
              <p className="hint" style={{ marginTop: 6 }}>
                Agents launched under it will be named <span className="mono">{`<role>.${checked.parent.name}`}</span>.
              </p>
              <div className="row" style={{ gap: 10, marginTop: 12 }}>
                <Link className="btn btn-sm btn-primary" href={`/launch?parent=${checked.parent.name}`}>
                  Launch an agent
                </Link>
                <Link className="btn btn-sm btn-ghost" href={`/fleet?parent=${checked.parent.name}`}>
                  See its fleet
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
                  <a className="mono" href={txUrl(entry.tx as `0x${string}`)} target="_blank" rel="noreferrer">
                    {shortHex(entry.tx as `0x${string}`)}
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
