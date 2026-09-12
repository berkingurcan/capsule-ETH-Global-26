"use client";

/* ------------------------------------------------------------------
   Bring your own name.

   One button, over a checklist of facts read off Sepolia. The checklist came
   first and is still the truth on the screen: every row is a fact, nothing is
   remembered, and reloading shows where you actually are because
   `readParentStatus` is the only thing the page believes.

   What changed is who pushes the buttons. Six rows in chain-dependency order is
   an honest description of the problem and a bad thing to hand someone who has
   never heard of a subregistry — so `runConnect` walks the list instead, doing
   the first missing step, re-reading, and repeating. The per-row buttons are
   still here behind "step through manually", because when something goes wrong
   mid-flow the ability to take one step at a time is the whole reason the page
   was built this way.

   Re-reading between steps rather than following a plan is what makes that safe.
   A wizard holding step state in React would happily ask someone to deploy a
   second resolver because it forgot they had one — and since both deployments
   land on deterministic CREATE2 addresses, that second deploy does not waste
   money, it reverts with no reason data. `runConnect` looks for the contracts at
   their predicted addresses before it offers to deploy anything.

   The first two steps are the subregistry, and they used to be an apology. A
   `.eth` name on this deployment has none, nothing can create a subname under it
   until it does, and the page's advice was to go and do it in ENS's own manager
   app — which turns out not to offer the operation either. So the advice could
   not be followed, and a name bought through /register had nowhere to go at all.
   Now the page does it: deploy a `PermissionedRegistry`, then link it to the name
   in both directions.

   The exception the page still cannot resolve is a wallet that does not own the
   name. `ROLE_SET_SUBREGISTRY` goes to whoever registered it, so for anyone else
   this is not a missing button but a missing permission, and the page says which
   wallet to come back with instead of offering a transaction that would revert.
   ------------------------------------------------------------------ */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import Capsule from "@/components/Capsule";
import { ACTIVE, CHAIN } from "@/lib/capsule/chain";
import {
  ConnectError,
  connectParent,
  attachSubregistry,
  deployResolver,
  deploySubregistry,
  linkSubregistryParent,
  grantRegistrar,
  grantResolverRoles,
  minterHasResolverRoles,
  runConnect,
  setParentOpen,
  supportsBatching,
} from "@/lib/capsule/connect";
import {
  encodeParent,
  parentNameProblems,
  readParentStatus,
  type ParentStatus,
} from "@/lib/capsule/parent";
import { shortAddress, useWallet } from "@/lib/wallet/WalletProvider";
import { shortHex, txUrl } from "@/lib/format";


type Busy = null | { step: string; detail?: string };

export default function ConnectName({
  minter,
  initialName = "",
}: {
  minter: string | null;
  initialName?: string;
}) {
  const { address, chainOk, status, getWalletClient, getPublicClient, switchChain } = useWallet();
  const connected = status === "connected" && address !== null;

  const [raw, setRaw] = useState(initialName.trim().toLowerCase());
  const [checked, setChecked] = useState<ParentStatus | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<{ text: string; tx?: string }[]>([]);
  const [open, setOpen] = useState(false);
  /** The resolver this session deployed, or one the user pasted after a reload. */
  const [freshResolver, setFreshResolver] = useState<Address | null>(null);
  /* The registry deployed in this session, before ENS has been told about it.

     On the beta deployment a registry is a plain CREATE deployment: its address
     depends on the sender's nonce and is gone the moment this state is, which is
     why the field below is editable — five million gas is at stake and a reloaded
     user can paste the address from their wallet history instead of paying twice.

     On the active deployment it is a `VerifiableFactory` proxy, so the address is
     deterministic in (factory, wallet, salt) and `runConnect` finds it by looking
     rather than by being told. The field stays for the other deployment. */
  const [freshRegistry, setFreshRegistry] = useState<Address | null>(null);
  /* Step-through mode. Off by default: the one button is the flow, and the six
     per-row transactions are the escape hatch for when it stops halfway. */
  const [manual, setManual] = useState(false);
  /* Whether this wallet will take the whole sequence under one confirmation
     (EIP-5792). Only used to set expectations before anybody clicks — the
     decision itself is made again inside `runConnect`, against the wallet. */
  const [batchable, setBatchable] = useState(false);
  /* Does the minter already hold its roles on the resolver we would use?

     Not a field of `ParentStatus`, and it cannot be: `readiness` derives
     `resolverRolesGranted` from `parent.resolver`, which is zero until
     `connectParent` has run. So a resolver deployed with the grants baked into
     its `initialize` reads as ungranted right up to the final step, and the row
     would offer a redundant grant. Asked of the minter's own view function
     instead, against the resolver this page would actually use. */
  const [resolverRoles, setResolverRoles] = useState<boolean | null>(null);

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

  /* A name arriving from /register was bought seconds ago, so the visitor should
     land on its checklist rather than on an empty form. Fires once, as soon as
     there is a wallet to read with. */
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || initialName === "" || !connected || !chainOk || minter === null) return;
    if (parentNameProblems(initialName).length > 0) return;
    prefilled.current = true;
    void refresh();
  }, [initialName, connected, chainOk, minter, refresh]);

  /* Ask the wallet once whether it speaks EIP-5792, so the button can say what
     will happen before it happens. `runConnect` asks again for itself — this is a
     label, not a decision. */
  useEffect(() => {
    if (!connected || !chainOk) {
      setBatchable(false);
      return;
    }
    const walletClient = getWalletClient();
    if (walletClient === null) return;
    let live = true;
    void supportsBatching(walletClient, address as Address, CHAIN.id).then((ok) => {
      if (live) setBatchable(ok);
    });
    return () => {
      live = false;
    };
  }, [connected, chainOk, address, getWalletClient]);

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

  /* The deployment the checked name actually lives on. Read off the status
     rather than imported, so the same page connects a hackathon-registered name
     and a beta one without the user choosing. Before a name has been checked
     there is nothing to act on, so the active deployment is a safe stand-in. */
  const deployment = checked?.deployment ?? ACTIVE;

  /* ---------------- the one button ----------------

     Everything below it still exists and is still reachable; this is the loop
     that pushes them in order. It owns no step state — `runConnect` re-reads the
     chain between every transaction — so stopping it halfway and clicking it
     again resumes, and so does reloading the page and clicking it again. */
  const onConnectAll = () =>
    run("Connecting", async ({ walletClient, publicClient }) => {
      const status = await runConnect(
        {
          walletClient,
          publicClient,
          account: address as Address,
          minter: minter as Address,
          parent: encodeParent(raw),
          open,
          knownRegistry: freshRegistry,
          knownResolver: freshResolver,
          onRegistry: setFreshRegistry,
          onResolver: setFreshResolver,
        },
        (event) => {
          if (event.done !== undefined) {
            say(event.done, event.tx);
            return;
          }
          setBusy({
            step: event.step,
            detail:
              event.phase === undefined
                ? undefined
                : `${event.phase}${event.detail === undefined ? "" : ` · ${shortHex(event.detail as never)}`}`,
          });
        },
      );
      setChecked(status);
      setOpen(status.open);
    });

  /* ---------------- the steps, one at a time ---------------- */

  const onDeployResolver = () =>
    run("Deploying resolver", async ({ walletClient, publicClient }) => {
      const { hash, resolver } = await deployResolver(
        {
          walletClient,
          publicClient,
          admin: address as Address,
          deployment,
          minter: minter as Address,
        },
        phase("Deploying resolver"),
      );
      setFreshResolver(resolver);
      say(`resolver deployed at ${shortAddress(resolver)}`, hash);
    });

  /* ---------------- the subregistry, in two signatures ----------------

     Split the way the chain splits it. Deploying costs five million gas and
     attaching costs forty thousand, so a user who is interrupted between them
     must not be asked to pay for the deploy again — which means the address of
     the registry they just deployed has to survive, and `freshRegistry` holds
     it exactly as `freshResolver` holds the resolver's.

     The third transaction, `setParent`, is folded into the second: they are the
     two halves of one link, and there is no state between them worth resuming
     into. Leaving a registry attached but unparented is the failure mode this
     whole flow exists to avoid, so the button that creates that state also
     leaves it. */
  const onDeploySubregistry = () =>
    run("Deploying subregistry", async ({ walletClient, publicClient }) => {
      const { hash, registry } = await deploySubregistry(
        {
          walletClient,
          publicClient,
          owner: address as Address,
          deployment,
          minter: minter as Address,
        },
        phase("Deploying subregistry"),
      );
      setFreshRegistry(registry);
      say(`subregistry deployed at ${shortAddress(registry)}`, hash);
    });

  const onLinkSubregistry = () =>
    run("Linking subregistry", async ({ walletClient, publicClient }) => {
      const registry = registryToLink;
      if (registry === null) {
        setError("deploy a subregistry first, or paste the address of one you already have");
        return;
      }
      if (checked?.tokenId == null) {
        setError("this name has no token id on ENS — re-check it and try again");
        return;
      }
      /* Attach first, then point back. In this order a failure leaves the name
         with a registry that /connect will offer to finish linking; in the other
         order it leaves an orphan registry pointing at a name that has never
         heard of it, which reads as nothing having happened at all. */
      if (checked.registry === null) {
        await attachSubregistry(
          { walletClient, publicClient, tokenId: checked.tokenId, registry, deployment },
          phase("Linking subregistry · 1 of 2"),
        );
      }
      const hash = await linkSubregistryParent(
        { walletClient, publicClient, registry, label: checked.parent.label, deployment },
        phase("Linking subregistry · 2 of 2"),
      );
      say(`${checked.parent.name} can now issue subnames`, hash);
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
  /* "Has a subregistry" means both halves of the link, not one. A registry that
     is attached but has never been told its parent passes every visible test —
     the name has a subregistry, subnames resolve downward — and then fails every
     record write, because resolver authorization walks upward. Treating the
     half-linked state as done is precisely the bug this flow exists to prevent,
     so the flag that gates the rest of the checklist requires both. */
  const linkedSubregistry = checked !== null && checked.registry !== null && checked.parentLinked;
  const hasSubregistry = linkedSubregistry;

  /** The registry the link step will use: whatever ENS already has, else this session's. */
  const registryToLink: Address | null = (checked?.registry as Address | null) ?? freshRegistry;
  /* Whether the deploy has been paid for, whether or not ENS knows yet. */
  const deployedRegistry = registryToLink !== null;
  const mayFixSubregistry = checked?.callerMaySetSubregistry === true;

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

  /* Whether the minter can already write records through the resolver in play.

     `readiness` cannot say so before `connectParent` — see `resolverRoles` above —
     and since the resolver is now deployed with those roles granted in its
     `initialize`, believing `readiness` here would show a "no" next to a resolver
     that has been ready since the moment it existed. */
  useEffect(() => {
    if (!connected || minter === null || resolverToUse === null) {
      setResolverRoles(null);
      return;
    }
    const publicClient = getPublicClient();
    if (publicClient === null) return;
    let live = true;
    void minterHasResolverRoles(publicClient, minter as Address, resolverToUse).then((ok) => {
      if (live) setResolverRoles(ok);
    });
    return () => {
      live = false;
    };
  }, [connected, minter, resolverToUse, checked, getPublicClient]);

  /* The grant row is satisfied by either source: the minter's stored parent (once
     connected) or the resolver itself (before that). */
  const resolverRolesOk = checked?.resolverRolesGranted === true || resolverRoles === true;

  /** Is there anything left for the one button to do? */
  const allDone = checked !== null && checked.callerMayMint;

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
        <p className="hint" style={{ marginTop: -6 }}>
          Don&rsquo;t own one on this deployment yet?{" "}
          <Link href="/register">Register a name</Link> — it takes two transactions and the beta&rsquo;s test token
          is free to mint.
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

          {/* --- 0. does the name exist at all ---

               Before anything about permissions. Someone who has not registered
               a name is not stuck, they are simply early, and the whole panel
               below would tell them about roles they cannot grant on a name they
               do not own. The label carries across so /register opens on the
               name they already typed here. */}
          {!checked.registered ? (
            <div className="notice" style={{ marginTop: 14, borderColor: "var(--sun-700, var(--line))" }}>
              <strong>Nobody owns {checked.parent.name} yet.</strong>
              <p className="hint" style={{ marginTop: 6 }}>
                It is not registered on this deployment, so there is nothing to connect. Names here are bought from
                ENS&rsquo;s own registrar for about 8 USDC a year — Capsule takes no part of that and never holds
                the name.
              </p>
              <div className="row" style={{ gap: 10, marginTop: 12 }}>
                <Link
                  className="btn btn-sm btn-primary"
                  href={`/register?label=${encodeURIComponent(checked.parent.label)}`}
                >
                  Register {checked.parent.name}
                </Link>
                <button className="btn btn-sm btn-ghost" onClick={() => void refresh()} disabled={reading}>
                  {reading ? "Checking…" : "I have just registered it"}
                </button>
              </div>
            </div>
          ) : (
          <>
          {/* --- the one button, and the escape hatch next to it ---

               `callerMayMint` is the whole of "is this name usable", so it is also
               the whole of "is there anything left to do". When it is false the
               button runs every remaining step; when it is true there is nothing
               to run and the panel below is a receipt. */}
          {!allDone && checked.callerMaySetSubregistry !== false && (
            <div className="tile" style={{ marginTop: 14 }}>
              <div className="spread" style={{ alignItems: "flex-start", gap: 16 }}>
                <div style={{ minWidth: 0 }}>
                  <strong>Connect {checked.parent.name}</strong>
                  <p className="hint" style={{ marginTop: 6, maxWidth: "62ch" }}>
                    {batchable
                      ? "Your wallet can take the whole sequence under one confirmation, so this is one signature. Everything it grants is revocable, and the registry and resolver it deploys are yours."
                      : "Each step is its own transaction, so your wallet will ask a few times in a row. Stop whenever you like — the page reads the chain, not its own memory, so clicking again picks up exactly where you left off."}
                  </p>
                </div>
                <span className="push">
                  <button
                    className="btn btn-primary"
                    onClick={onConnectAll}
                    disabled={busy !== null || reading}
                  >
                    {busy !== null ? "Working…" : batchable ? "Connect (1 signature)" : "Connect this name"}
                  </button>
                </span>
              </div>
              <div className="row" style={{ gap: 10, marginTop: 12 }}>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => setManual((value) => !value)}
                  disabled={busy !== null}
                >
                  {manual ? "Hide the individual steps" : "Step through manually"}
                </button>
                <span className="hint">
                  {manual
                    ? "Every row below is one transaction, in the order the chain requires."
                    : "Below is what it will do, read off Sepolia."}
                </span>
              </div>
            </div>
          )}

          {/* --- 1. the subregistry: deploy it, then link it both ways --- */}
          <Row
            done={deployedRegistry}
            title="Has a subregistry"
            detail={
              deployedRegistry
                ? `${shortAddress(registryToLink as Address)} will issue this name's subnames`
                : "a name on this deployment gets none by default"
            }
          >
            {manual && !deployedRegistry && mayFixSubregistry && (
              <button
                className="btn btn-sm btn-primary"
                onClick={onDeploySubregistry}
                disabled={busy !== null}
              >
                Deploy one
              </button>
            )}
          </Row>

          {deployedRegistry && !linkedSubregistry && (
            <Row
              done={false}
              title="Linked to the name"
              detail="ENS has to agree in both directions before subnames work"
            >
              {manual && (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={onLinkSubregistry}
                  disabled={busy !== null}
                >
                  {checked.registry === null ? "Link it (2 signatures)" : "Finish linking"}
                </button>
              )}
            </Row>
          )}

          {!hasSubregistry && !mayFixSubregistry && (
            <div className="notice" style={{ marginTop: 14, borderColor: "var(--alarm)" }}>
              <strong>This wallet cannot give {checked.parent.name} a subregistry.</strong>
              <p className="hint" style={{ marginTop: 6 }}>
                ENS grants that permission to whoever registered the name. Connect with the wallet that bought{" "}
                <span className="mono">{checked.parent.name}</span>, or ask them to run this step — it is two
                signatures and they keep full control of the result.
              </p>
            </div>
          )}

          {!hasSubregistry && mayFixSubregistry && (
            <div className="notice" style={{ marginTop: 14 }}>
              <strong>
                {deployedRegistry
                  ? "One step left before this name can issue subnames."
                  : "A name on this deployment cannot issue subnames until it has a registry of its own."}
              </strong>
              <p className="hint" style={{ marginTop: 6 }}>
                Nothing can create <span className="mono">{`x.${checked.parent.name}`}</span> — not Capsule, not you
                — until a <span className="mono">PermissionedRegistry</span> exists and ENS and it point at each
                other. The registry is yours outright: you are its only admin, Capsule gets one revocable role on it
                further down this page, and it keeps working if you never finish.
              </p>
              <p className="hint" style={{ marginTop: 8 }}>
                {deployedRegistry
                  ? "The contract is already deployed. What is left is the link itself, which is cheap."
                  : deployment.userRegistryImpl === undefined
                    ? "The deployment is the expensive part of connecting — roughly five million gas, once, ever."
                    : "On this deployment the registry is a proxy, so it is an ordinary transaction rather than the five million gas a whole contract would cost."}
              </p>
              {deployedRegistry && checked.registry === null && (
                <label className="field" style={{ marginTop: 10 }}>
                  <span className="flabel">Subregistry address</span>
                  <input
                    className="input mono"
                    value={freshRegistry ?? ""}
                    onChange={(e) => setFreshRegistry((e.target.value.trim() || null) as Address | null)}
                    spellCheck={false}
                  />
                  {/* Editable because a plain CREATE address cannot be recovered
                      by redeploying, unlike the resolver proxy's. Someone who
                      reloaded between the two steps has already paid for this
                      contract; pasting it from their wallet history is much
                      better than buying a second one. */}
                  <span className="hint">
                    Deployed but not yet linked. If you reloaded the page, paste the address from your wallet
                    history rather than deploying again.
                  </span>
                </label>
              )}
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
                {manual && !hasResolver && (
                  <button
                    className="btn btn-sm btn-primary"
                    disabled={busy !== null || !checked.callerIsAdmin}
                    onClick={onDeployResolver}
                  >
                    Deploy one
                  </button>
                )}
              </Row>

              {manual && !storedResolver && (
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
                {manual && !checked.registrarGranted && (
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
                done={resolverRolesOk}
                title="Capsule may write records"
                detail={
                  resolverRolesOk
                    ? "four root roles on your resolver — revoke them and Capsule can never write under this name again"
                    : "four root roles on your resolver — the same ones it uses to hand you the kill switch"
                }
              >
                {manual && !resolverRolesOk && (
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
                {manual && !checked.connected && (
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
