"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import Capsule from "@/components/Capsule";
import { CHAIN } from "@/lib/capsule/chain";
import { RECORD_KEYS } from "@/lib/capsule/records";
import { shortAddress, useWallet } from "@/lib/wallet/WalletProvider";
import { ROLES, capColor, type Role } from "@/lib/capsule/roles";
import { PARENT_NAME, PARENT_NAME_DISPLAY, PARENT_NAME_MISSING } from "@/lib/capsule/public-env";
import { labelProblems, telegramTokenProblems } from "@/lib/capsule/prepare";
import { mintCapsule, minterCanWrite, MintError, type MintReceipt } from "@/lib/capsule/mint";
import {
  prepareCapsuleRequest,
  PrepareError,
  type PrepareResult,
} from "@/lib/capsule/prepare-client";
import { shortHex, txUrl } from "@/lib/format";
import {
  PROVIDERS,
  PROVIDER_IDS,
  SUGGESTED_MODELS,
  modelRefProblems,
  parseModelRef,
  type ProviderId,
} from "@/lib/capsule/providers";

/* ------------------------------------------------------------------
   The launchpad. Five steps, one form — the order matters: secrets are
   entered before the mint so the runner has everything it needs the
   moment the name exists, and the record only ever holds a pointer.

   The x402 checkout step was removed on 2026-09-08 (DECISIONS.md): the
   hackathon deployment mints for free, and a fee — if it ever exists —
   is one msg.value check on CapsuleMinter.mint().

   Steps 01–04 are real. Each capsule costs the owner one signature (the
   prepare request) and one transaction (the mint), in that order,
   because `mint()` takes the agent address and the prompt pointer as
   arguments and neither exists until the server has generated and
   sealed them.

   Step 05 is not wired: nothing here starts a machine yet, and the page
   says so rather than animating a boot that is not happening.
   ------------------------------------------------------------------ */

const STEPS = ["Wallet", "Roles", "Configure", "Mint", "Provision"];

/* Every `<provider>/<model>` the picker offers, grouped the way it renders.
   Not authoritative — OpenClaw's catalog is, and an owner may write any model
   their provider serves. This exists so the common case is two clicks. */
const MODEL_GROUPS = PROVIDER_IDS.map((id) => ({
  provider: id,
  label: PROVIDERS[id].label,
  refs: SUGGESTED_MODELS[id].map((model) => `${id}/${model}`),
}));

type Draft = {
  slug: string;
  title: string;
  cap: string;
  /** `<provider>/<model>`, written verbatim into `agent-model`. */
  model: string;
  /** `agent-context` — what this agent is, in plain language. */
  context: string;
  /** The prompt body. Sealed in the store; the record gets the pointer. */
  prompt: string;
  /** The bot's @name. Becomes `agent-endpoint[web]` as an https t.me URL. */
  handle: string;
  /** The Telegram bot token. Sealed, never on chain. */
  token: string;
  /**
   * The API key for the provider this capsule's model names.
   *
   * One key, not a map, because one key is what `POST /api/capsule/prepare`
   * seals today. The store keys credentials by provider slot and the runner
   * resolves the slot from `agent-model` at boot — so a capsule can hold
   * several — but nothing in the launchpad adds a second one, and collecting
   * keys the API would silently drop is worse than collecting one and saying
   * what that costs. What it costs is on the form, next to the field.
   */
  providerKey: string;
};

/** The provider half of a draft's model reference. */
function providerOf(draft: Draft): ProviderId | undefined {
  const parsed = parseModelRef(draft.model);
  if (parsed === null) return undefined;
  return PROVIDER_IDS.find((id) => id === parsed.provider);
}

/**
 * A bot's public handle.
 *
 * Telegram requires a bot username to be 5–32 characters of `[A-Za-z0-9_]` and
 * to end in `bot`. Checking it here is not pedantry: this string becomes
 * `agent-endpoint[web]`, which is the only place a stranger reading the name
 * can find the agent, and a wrong one is a record that points at nothing.
 */
function handleProblems(handle: string): string[] {
  if (handle === "") return ["the bot's @name is required — it is published as agent-endpoint[web]"];
  if (!/^[A-Za-z0-9_]{5,32}$/.test(handle)) {
    return ["is 5–32 characters of letters, digits and underscores"];
  }
  if (!/bot$/i.test(handle)) return ["Telegram bot usernames must end in “bot”"];
  return [];
}

/** The https URL written into the record. Built once, here. */
function telegramUrlOf(draft: Draft): string {
  return draft.handle === "" ? "" : `https://t.me/${draft.handle}`;
}

/**
 * Everything wrong with a draft, as the API would see it.
 *
 * Deliberately built from `lib/capsule/prepare.ts` — the same module the route
 * validates with — rather than from a second set of rules written here. A form
 * whose idea of "valid" differs from the server's produces the worst possible
 * error: one that only appears after the user has signed something.
 */
function draftProblems(draft: Draft, taken: string[]): string[] {
  const problems = labelProblems(draft.slug).map((m) => `label ${m}`);
  if (taken.includes(draft.slug)) problems.push("label is already minted");
  if (draft.context.trim() === "") problems.push("agent-context is required");
  if (draft.prompt.trim() === "") problems.push("the prompt body is required");
  for (const m of modelRefProblems(draft.model)) problems.push(`agent-model ${m}`);
  for (const m of handleProblems(draft.handle)) problems.push(`bot @name ${m}`);
  for (const m of telegramTokenProblems(draft.token)) problems.push(`bot token ${m}`);
  if (draft.providerKey.trim() === "") {
    const provider = providerOf(draft);
    problems.push(`an API key for ${provider ?? "the model's provider"} is required`);
  }
  return problems;
}

function draftFrom(r: Role): Draft {
  return {
    slug: r.slug,
    title: r.title,
    cap: r.cap,
    model: r.model,
    context: r.context,
    prompt: r.prompt,
    // Empty on purpose. This form used to open with a plausible-looking bot
    // token and a row of bullet characters in the key field, which was
    // harmless while nothing was sent anywhere and is not harmless now: those
    // values would be sealed into the store and written around on chain.
    handle: "",
    token: "",
    providerKey: "",
  };
}

/** A draft for a label nobody wrote a preset for. */
function customDraft(slug: string): Draft {
  return {
    slug,
    title: slug.charAt(0).toUpperCase() + slug.slice(1),
    cap: capColor(slug),
    model: "anthropic/claude-opus-5",
    context: "",
    prompt: "",
    handle: "",
    token: "",
    providerKey: "",
  };
}

export default function LaunchFlow({ taken, minter }: { taken: string[]; minter: string | null }) {
  // Preselect the first two presets that are still available, so the form does
  // not open with a selection the mint would reject.
  const free = ROLES.filter((r) => !taken.includes(r.slug)).slice(0, 2).map((r) => r.slug);

  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    ROLES.filter((r) => free.includes(r.slug)).map(draftFrom)
  );
  const [tab, setTab] = useState(0);
  const [custom, setCustom] = useState("");
  const [minted, setMinted] = useState<Minted[]>([]);

  const picked = drafts.map((d) => d.slug);

  /* A label minted in this session is taken as surely as one that was taken
     when the page loaded — `taken` is a snapshot from the server render and
     does not know about the transactions we just sent. */
  const unavailable = [...taken, ...minted.map((m) => m.draft.slug)];

  function toggle(r: Role) {
    if (unavailable.includes(r.slug)) return;
    setDrafts((d) =>
      d.some((x) => x.slug === r.slug) ? d.filter((x) => x.slug !== r.slug) : [...d, draftFrom(r)]
    );
    setTab(0);
  }

  function addCustom(slug: string) {
    if (slug === "" || picked.includes(slug) || unavailable.includes(slug)) return;
    if (labelProblems(slug).length > 0) return;
    setDrafts((d) => [...d, customDraft(slug)]);
    setCustom("");
  }

  function removeDraft(slug: string) {
    setDrafts((d) => d.filter((x) => x.slug !== slug));
    setTab(0);
  }

  function patch(i: number, p: Partial<Draft>) {
    setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...p } : x)));
  }

  return (
    <main className="page">
      <div className="wrap wrap-narrow">
        <div className="spread wrapflex" style={{ marginBottom: 20 }}>
          <div>
            <p className="kicker" style={{ margin: 0 }}>
              Launchpad
            </p>
            <h2 style={{ fontSize: 30, marginTop: 6 }}>Hire an agent under {PARENT_NAME_DISPLAY}</h2>
          </div>
          {step > 0 && step < 3 && (
            <button className="btn btn-sm btn-ghost" onClick={() => setStep(0)}>
              Start over
            </button>
          )}
        </div>

        <div className="rail" style={{ marginBottom: 28 }}>
          {STEPS.map((s, i) => (
            <div key={s} className={"rail-step" + (i === step ? " on" : i < step ? " done" : "")}>
              <span className="n">{i < step ? "✓" : i + 1}</span>
              <span className="t">{s}</span>
            </div>
          ))}
        </div>

        {step === 0 && <StepWallet minter={minter} next={() => setStep(1)} />}

        {step === 1 && (
          <StepRoles
            picked={picked}
            taken={unavailable}
            toggle={toggle}
            remove={removeDraft}
            custom={custom}
            setCustom={setCustom}
            addCustom={addCustom}
            back={() => setStep(0)}
            next={() => setStep(2)}
          />
        )}

        {step === 2 && (
          <StepConfigure
            drafts={drafts}
            taken={unavailable}
            tab={tab}
            setTab={setTab}
            patch={patch}
            back={() => setStep(1)}
            next={() => setStep(3)}
          />
        )}

        {step === 3 && (
          <StepMint
            drafts={drafts}
            minter={minter}
            already={minted.length}
            back={() => setStep(2)}
            /* Reported as each one lands, not in a batch at the end. A capsule
               that is minted is minted: it leaves the draft list so that going
               back to fix a *different* one cannot offer to mint it twice, and
               so that its result survives this step being unmounted. */
            onMinted={(m) => {
              setMinted((all) => [...all, m]);
              setDrafts((d) => d.filter((x) => x.slug !== m.draft.slug));
            }}
            done={() => setStep(4)}
          />
        )}

        {step === 4 && <StepProvision minted={minted} />}
      </div>
    </main>
  );
}

/* ---------------- 01 · wallet ---------------- */

/**
 * The preconditions of a mint, all four of them checked.
 *
 * This screen used to claim it had verified that the user owns
 * `capsulefleet.eth`. That was never true and could not become true:
 * `CapsuleMinter.mint()` is permissionless. The parent is held by the minter,
 * which carries root roles on the resolver; anyone may mint a free label under
 * it and name themselves owner. So the honest list is what the mint actually
 * requires, and the one item that can fail invisibly — the minter's roles —
 * is read off the chain rather than asserted.
 */
function StepWallet({ minter, next }: { minter: string | null; next: () => void }) {
  const { status, address, chainOk, chainId, wallets, connect, switchChain, getPublicClient } = useWallet();
  const connected = status === "connected" && address !== null;

  const [roles, setRoles] = useState<"unknown" | "checking" | "ok" | "revoked">("unknown");

  useEffect(() => {
    if (!chainOk || minter === null) {
      setRoles("unknown");
      return;
    }
    const client = getPublicClient();
    if (client === null) return;
    let live = true;
    setRoles("checking");
    void minterCanWrite(client, minter as Address).then((ok) => {
      if (live) setRoles(ok ? "ok" : "revoked");
    });
    return () => {
      live = false;
    };
  }, [chainOk, minter, getPublicClient]);

  const ready = connected && chainOk && minter !== null && roles === "ok" && !PARENT_NAME_MISSING;

  const checks: [string, string, boolean][] = [
    ["A wallet is connected", address ?? "no account", connected],
    ["It is on " + CHAIN.name, chainOk ? "chain " + CHAIN.id : "chain " + (chainId ?? "?"), chainOk],
    [
      "This deployment knows its minter",
      minter === null ? "CAPSULE_MINTER_ADDRESS is not set on the server" : minter,
      minter !== null,
    ],
    [
      "The minter can still write records",
      roles === "ok"
        ? "checkResolverRoles() passed"
        : roles === "revoked"
          ? "its resolver roles were revoked — every mint would revert"
          : roles === "checking"
            ? "reading the resolver…"
            : "checked once a wallet is connected",
      roles === "ok",
    ],
  ];

  return (
    <div className="panel pad-lg">
      <div className="stepline">
        <span className="stepnum">01</span>
        <span className="tag">Connect wallet</span>
      </div>
      <p className="stitle">Connect the wallet that will own the agents</p>
      <p className="ssub">
        Capsule mints subnames under <span className="mono">{PARENT_NAME_DISPLAY}</span>, which the minter contract
        holds. You do not need to own the parent — you need the wallet you want the subname, and its kill switch,
        to belong to.
      </p>

      <div className="grid g-side" style={{ alignItems: "stretch" }}>
        <div className="tile shell" style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
          <Capsule size={64} cap={ready ? "#1B4FD8" : "#C4D5F6"} />
          <div style={{ minWidth: 0 }}>
            <div className="ensname" style={{ fontSize: 24 }}>
              {PARENT_NAME_DISPLAY}
            </div>
            <div className="mono" style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4 }}>
              {connected ? shortAddress(address) + " · connected" : "no wallet connected"}
            </div>
            <div className="row wrapflex" style={{ gap: 7, marginTop: 12 }}>
              <span className="tag">ENSv2 registry</span>
              <span className="tag">{CHAIN.name}</span>
            </div>
          </div>

          <span className="push">
            {ready ? (
              <span className="pill run">
                <span className="led" />
                Ready
              </span>
            ) : connected && !chainOk ? (
              <button className="btn btn-sm btn-danger" onClick={() => void switchChain()}>
                Switch to {CHAIN.name}
              </button>
            ) : connected ? (
              <span className="pill wait">
                <span className="led pulse" />
                Checking
              </span>
            ) : (
              <button
                className="btn btn-sm btn-primary"
                disabled={status === "connecting"}
                onClick={() => void connect(wallets.length === 1 ? wallets[0]!.info.rdns : undefined)}
              >
                {status === "connecting" ? "Connecting…" : "Connect wallet"}
              </button>
            )}
          </span>
        </div>

        <div className="tile">
          <div className="label" style={{ marginBottom: 12 }}>
            What the mint needs
          </div>
          <div className="stack">
            {checks.map(([a, b, done]) => (
              <div key={a} className="row-top" style={{ gap: 10, padding: "10px 0" }}>
                <span
                  className={"check" + (done ? " on" : "")}
                  style={{
                    width: 20,
                    height: 20,
                    borderWidth: 2.5,
                    fontSize: 11,
                    background: done ? "var(--mint)" : "transparent",
                    color: done ? "var(--ink)" : "var(--muted)",
                  }}
                >
                  {done ? "✓" : "·"}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: done ? "var(--ink)" : "var(--muted)" }}>{a}</div>
                  <div className="hint mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>
                    {b}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {PARENT_NAME_MISSING && (
        <div className="notice" style={{ marginTop: 20, borderColor: "var(--line)" }}>
          <span className="tag">Misconfigured</span>
          <p style={{ margin: 0 }}>
            <span className="mono">NEXT_PUBLIC_CAPSULE_PARENT_NAME</span> is unset, so this form does not know what
            it would be minting under. Nothing can be launched until it is set.
          </p>
        </div>
      )}

      <div className="row" style={{ marginTop: 26, gap: 10 }}>
        <span className="hint">
          {ready
            ? "Ready."
            : !connected
              ? "Connect a wallet to continue."
              : !chainOk
                ? "Wrong network."
                : roles === "revoked"
                  ? "The minter cannot write to the resolver."
                  : "Checking the minter…"}
        </span>
        <button className="btn btn-primary push" onClick={next} disabled={!ready}>
          Pick roles →
        </button>
      </div>
    </div>
  );
}

/* ---------------- 02 · roles ---------------- */

function StepRoles({
  picked,
  taken,
  toggle,
  remove,
  custom,
  setCustom,
  addCustom,
  back,
  next,
}: {
  picked: string[];
  /** Labels already minted under the parent, read from CapsuleMinted logs. */
  taken: string[];
  toggle: (r: Role) => void;
  remove: (slug: string) => void;
  custom: string;
  setCustom: (v: string) => void;
  addCustom: (slug: string) => void;
  back: () => void;
  next: () => void;
}) {
  /* The custom field used to say "checked against the subregistry as you type"
     and then call every label free, which it could not know. It is checked
     against the labels this page was rendered with — a real answer with a real
     limit, stated — and against the same label rules the API applies. */
  const customTaken = taken.includes(custom);
  const customPicked = picked.includes(custom);
  const customProblems = custom === "" ? [] : labelProblems(custom);
  const customOk = custom !== "" && customProblems.length === 0 && !customTaken && !customPicked;

  const extras = picked.filter((slug) => !ROLES.some((r) => r.slug === slug));

  return (
    <div className="panel pad-lg">
      <div className="stepline">
        <span className="stepnum">02</span>
        <span className="tag">Select subnames</span>
      </div>
      <p className="stitle">Pick the roles you want to hire</p>
      <p className="ssub">
        Each role becomes a subname under <span className="mono">{PARENT_NAME_DISPLAY}</span>. The label is the job — and
        because the agent reads its own name at boot, the label is also half its configuration.
      </p>

      <div className="grid g3">
        {ROLES.map((r) => {
          const on = picked.includes(r.slug);
          const isTaken = taken.includes(r.slug);
          return (
            <button
              key={r.slug}
              type="button"
              className={"pick" + (on ? " on" : "") + (isTaken ? " taken" : "")}
              onClick={() => toggle(r)}
              disabled={isTaken}
              aria-pressed={on}
            >
              <div className="row" style={{ gap: 12 }}>
                <Capsule size={40} cap={isTaken ? "#C4D5F6" : r.cap} shell={isTaken ? "#E4EBFA" : "#F2F6FF"} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{r.title}</div>
                  <div className="hint" style={{ fontSize: 12.5 }}>
                    {isTaken ? "already minted" : r.blurb}
                  </div>
                </div>
                <span className={"check push" + (on ? " on" : "")} style={on ? { background: r.cap } : undefined}>
                  ✓
                </span>
              </div>
              <div className="ensname" style={{ fontSize: 13.5 }}>
                {r.slug}
                <span className="p">.{PARENT_NAME_DISPLAY}</span>
              </div>
            </button>
          );
        })}

        <div className="pick" style={{ borderStyle: "dashed", cursor: "default" }}>
          <div className="label">Custom role</div>
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input"
              placeholder="ops"
              value={custom}
              onChange={(e) => setCustom(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && customOk) addCustom(custom);
              }}
              aria-label="Custom role label"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button className="btn btn-sm" disabled={!customOk} onClick={() => addCustom(custom)}>
              Add
            </button>
          </div>
          <div className="hint" style={{ fontSize: 12.5 }}>
            {custom === "" ? (
              "Any label that is free under the parent."
            ) : customProblems.length > 0 ? (
              <span style={{ color: "var(--danger, #C0392B)" }}>{customProblems[0]}</span>
            ) : customTaken ? (
              <span style={{ color: "var(--danger, #C0392B)" }}>already minted</span>
            ) : customPicked ? (
              "already in your list"
            ) : (
              <span style={{ color: "var(--mint-700)", fontWeight: 600 }}>
                free as of this page load — the mint is what decides
              </span>
            )}
          </div>
        </div>
      </div>

      {extras.length > 0 && (
        <div className="row wrapflex" style={{ gap: 8, marginTop: 18 }}>
          <span className="label">Custom</span>
          {extras.map((slug) => (
            <button key={slug} className="btn btn-sm btn-ghost" onClick={() => remove(slug)}>
              <Capsule size={16} cap={capColor(slug)} />
              {slug} ✕
            </button>
          ))}
        </div>
      )}

      <div className="row wrapflex" style={{ marginTop: 26, gap: 14 }}>
        <button className="btn btn-ghost btn-sm" onClick={back}>
          ← Back
        </button>
        <span className="mono push" style={{ fontSize: 13, fontWeight: 600, color: "var(--muted)" }}>
          {picked.length} SELECTED
        </span>
        <button className="btn btn-primary" disabled={picked.length === 0} onClick={next}>
          Configure →
        </button>
      </div>
    </div>
  );
}

/* ---------------- 03 · configure ---------------- */

function StepConfigure({
  drafts,
  taken,
  tab,
  setTab,
  patch,
  back,
  next,
}: {
  drafts: Draft[];
  taken: string[];
  tab: number;
  setTab: (i: number) => void;
  patch: (i: number, p: Partial<Draft>) => void;
  back: () => void;
  next: () => void;
}) {
  if (drafts.length === 0) {
    return (
      <div className="panel pad-lg">
        <div className="stepline">
          <span className="stepnum">03</span>
          <span className="tag">Credentials &amp; logic</span>
        </div>
        <p className="stitle">Nothing left to configure</p>
        <p className="ssub">Every capsule you picked has been minted. Go back and pick another role to hire.</p>
        <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={back}>
          ← Pick roles
        </button>
      </div>
    );
  }

  const i = Math.min(tab, drafts.length - 1);
  const d = drafts[i]!;
  const provider = providerOf(d);
  const spec = provider === undefined ? undefined : PROVIDERS[provider];

  /* Every draft, not just the visible one: the button that leaves this step
     commits all of them, so it must not be enabled by whichever tab happens to
     be open. */
  const blocked = drafts.filter((x) => draftProblems(x, taken).length > 0);
  const problems = draftProblems(d, taken);

  return (
    <div className="panel pad-lg">
      <div className="stepline">
        <span className="stepnum">03</span>
        <span className="tag">Credentials &amp; logic</span>
      </div>
      <p className="stitle">Give each capsule its brain and its mouth</p>
      <p className="ssub">
        Everything on the left is written into the ENS record and read by the runner at boot. Everything on the right
        is a secret — it goes to the encrypted store, and the record holds only a pointer.
      </p>

      <div className="row wrapflex" style={{ gap: 8, marginBottom: 20 }}>
        {drafts.map((x, j) => {
          const bad = draftProblems(x, taken).length > 0;
          return (
            <button
              key={x.slug}
              className={"btn btn-sm" + (j === i ? "" : " btn-ghost")}
              style={j === i ? { background: x.cap } : undefined}
              onClick={() => setTab(j)}
            >
              <Capsule size={16} cap={x.cap} />
              {x.slug}
              {bad ? " ·" : " ✓"}
            </button>
          );
        })}
      </div>

      <div className="grid g-side">
        <div className="col" style={{ gap: 18 }}>
          <div className="field">
            <label className="label" htmlFor="model">
              {RECORD_KEYS.model}
            </label>
            <select id="model" className="select" value={d.model} onChange={(e) => patch(i, { model: e.target.value })}>
              {MODEL_GROUPS.map((group) => (
                <optgroup key={group.provider} label={group.label}>
                  {group.refs.map((ref) => (
                    <option key={ref} value={ref}>
                      {ref}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <span className="hint">
              Written on chain as <span className="mono">&lt;provider&gt;/&lt;model&gt;</span>. Change it later
              and the same machine restarts on a different brain — no redeploy, no re-mint.
            </span>
          </div>

          <div className="field">
            <label className="label" htmlFor="context">
              {RECORD_KEYS.context}
            </label>
            <input
              id="context"
              className="input"
              value={d.context}
              onChange={(e) => patch(i, { context: e.target.value })}
            />
            <span className="hint">
              ENSIP-26. One plain sentence, and the only record a generic ENS client will show a human.
            </span>
          </div>

          <div className="field">
            <label className="label" htmlFor="handle">
              {RECORD_KEYS.endpointWeb}
            </label>
            <div className="row" style={{ gap: 0 }}>
              <span
                className="mono"
                style={{ fontSize: 12.5, color: "var(--muted)", padding: "0 8px 0 0", whiteSpace: "nowrap" }}
              >
                https://t.me/
              </span>
              <input
                id="handle"
                className="input"
                placeholder="my_analyst_bot"
                value={d.handle}
                onChange={(e) => patch(i, { handle: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })}
                style={{ flex: 1, minWidth: 0 }}
              />
            </div>
            <span className="hint">
              The @name BotFather gave you. This is the record a stranger reading the name uses to find the agent,
              so it goes on chain in the clear — the token beside it never does.
            </span>
          </div>

          <div className="field">
            <label className="label" htmlFor="prompt">
              {RECORD_KEYS.prompt} · the body
            </label>
            <textarea
              id="prompt"
              className="textarea"
              value={d.prompt}
              onChange={(e) => patch(i, { prompt: e.target.value })}
            />
            <span className="hint">
              This never goes on chain. It is sealed in the store and the record holds only the pointer —
              change the pointer later and the agent picks it up within 30 seconds. No redeploy.
            </span>
          </div>
        </div>

        <div className="col" style={{ gap: 18 }}>
          <div className="notice sun">
            <span className="tag ink">Rule</span>
            <p style={{ margin: 0 }}>
              Secrets never go onchain. The record holds an opaque pointer like{" "}
              <span className="mono">cap_8f3d1a</span>; the real values sit encrypted in Postgres and are fetched by
              the runner over an authenticated call.
            </p>
          </div>

          <div className="field">
            <label className="label" htmlFor="tg">
              Telegram bot token
            </label>
            <input id="tg" className="input" type="password" placeholder="123456789:AA…" value={d.token} onChange={(e) => patch(i, { token: e.target.value })} />
            <span className="hint">From @BotFather. This is how you will talk to the agent.</span>
          </div>

          <div className="field">
            <label className="label" htmlFor="key">
              {spec === undefined ? "Provider API key" : spec.envVar}
            </label>
            <input
              id="key"
              className="input"
              type="password"
              placeholder={spec?.keyHint ?? "sk-…"}
              value={d.providerKey}
              onChange={(e) => patch(i, { providerKey: e.target.value })}
            />
            <span className="hint">
              The key for <span className="mono">{provider ?? "the provider named above"}</span>, because that is
              what <span className="mono">{d.model}</span> will be billed to. The store files keys by provider and
              the runner looks up whichever one <span className="mono">{RECORD_KEYS.model}</span> names — but the
              launchpad only seals this one, so switching the record to a provider you have not stored a key for
              will stop the agent until there is a way to add it.
            </span>
          </div>

          {problems.length > 0 && (
            <div className="notice" style={{ borderColor: "var(--line)" }}>
              <span className="tag">Not ready</span>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {problems.map((p) => (
                  <li key={p} style={{ fontSize: 13 }}>
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="tile shell">
            <div className="label" style={{ marginBottom: 10 }}>
              What lands in the record
            </div>
            <pre className="term" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
              <span className="d">addr </span>
              <span className="w">generated at prepare, published by the mint</span>
              {"\n"}
              <span className="d">{RECORD_KEYS.context} </span>
              <span className="w">{d.context || "—"}</span>
              {"\n"}
              <span className="d">{RECORD_KEYS.endpointWeb} </span>
              <span className="w">{telegramUrlOf(d) || "—"}</span>
              {"\n"}
              <span className="d">{RECORD_KEYS.model} </span>
              <span className="w">{d.model}</span>
              {"\n"}
              <span className="d">{RECORD_KEYS.runtime} </span>
              <span className="w">openclaw</span>
              {"\n"}
              <span className="d">{RECORD_KEYS.prompt} </span>
              <span className="y">a pointer the server allocates</span>
              {"\n"}
              <span className="d">{RECORD_KEYS.heartbeat} </span>
              <span className="g">written by the agent</span>
            </pre>
          </div>
        </div>
      </div>

      <div className="row wrapflex" style={{ marginTop: 26, gap: 10 }}>
        <button className="btn btn-ghost btn-sm" onClick={back}>
          ← Back
        </button>
        <span className="hint push">
          {blocked.length === 0
            ? `${drafts.length} ready`
            : `${blocked.map((x) => x.slug).join(", ")} still needs something`}
        </span>
        <button className="btn btn-primary" onClick={next} disabled={blocked.length > 0}>
          Continue to mint →
        </button>
      </div>
    </div>
  );
}

/* ---------------- 04 · mint ---------------- */

export type Minted = {
  draft: Draft;
  prepared: PrepareResult;
  receipt: MintReceipt;
};

type Phase = "idle" | "preparing" | "simulating" | "signing" | "mining" | "done" | "failed";

type Run = {
  phase: Phase;
  lines: string[];
  error: string | null;
  /** Kept across a retry: re-preparing would mint a second agent keypair and
   *  leave the first one's sealed rows addressed by nothing. */
  prepared: PrepareResult | null;
  receipt: MintReceipt | null;
};

const IDLE: Run = { phase: "idle", lines: [], error: null, prepared: null, receipt: null };

function StepMint({
  drafts,
  minter,
  already,
  back,
  onMinted,
  done,
}: {
  drafts: Draft[];
  minter: string | null;
  /** How many capsules minted on an earlier visit to this step. */
  already: number;
  back: () => void;
  onMinted: (minted: Minted) => void;
  done: () => void;
}) {
  const { address, chainOk, getWalletClient, getPublicClient } = useWallet();

  /* The queue is a snapshot taken when this step opens. `drafts` shrinks as
     each capsule mints — that is what keeps a minted one out of a later run —
     and an array this component is iterating must not shrink underneath it. */
  const [queue] = useState<Draft[]>(drafts);
  const [runs, setRuns] = useState<Run[]>(() => queue.map(() => ({ ...IDLE })));
  const [active, setActive] = useState<number | null>(null);

  const update = useCallback((i: number, p: Partial<Run>) => {
    setRuns((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  }, []);

  const say = useCallback((i: number, line: string) => {
    setRuns((r) => r.map((x, j) => (j === i ? { ...x, lines: [...x.lines, line] } : x)));
  }, []);

  const running = active !== null;
  const doneCount = useMemo(() => runs.filter((r) => r.receipt !== null).length, [runs]);
  const allDone = doneCount === queue.length;

  /**
   * One capsule, end to end.
   *
   * Two things the user must approve, in this order and for this reason: the
   * prepare signature comes first because `mint()` takes the agent address and
   * the prompt pointer as arguments, and neither exists until the server has
   * generated the keypair and sealed the prompt. There is no way to do the
   * transaction first.
   */
  async function runOne(i: number): Promise<boolean> {
    const draft = queue[i]!;
    const walletClient = getWalletClient();
    const publicClient = getPublicClient();

    if (walletClient === null || publicClient === null || address === null) {
      update(i, { phase: "failed", error: "The wallet is not connected to " + CHAIN.name + "." });
      return false;
    }
    if (minter === null) {
      update(i, { phase: "failed", error: "CAPSULE_MINTER_ADDRESS is not set on the server." });
      return false;
    }

    let prepared = runs[i]!.prepared;

    if (prepared === null) {
      update(i, { phase: "preparing", error: null });
      say(i, "prepare · sign to seal the prompt and credentials");
      try {
        prepared = await prepareCapsuleRequest(
          {
            label: draft.slug,
            owner: address,
            context: draft.context,
            telegramUrl: telegramUrlOf(draft),
            model: draft.model,
            prompt: draft.prompt,
            telegramToken: draft.token,
            providerKey: draft.providerKey,
          },
          (args) => walletClient.signMessage({ account: address, message: args.message }),
          { parentName: PARENT_NAME }
        );
      } catch (error) {
        const message =
          error instanceof PrepareError
            ? error.failure.problems !== undefined
              ? error.failure.problems.map((p) => `${p.field} ${p.message}`).join("; ")
              : error.failure.error
            : error instanceof Error && /rejected|denied/i.test(error.message)
              ? "Signature rejected in the wallet."
              : error instanceof Error
                ? error.message
                : "prepare failed";
        update(i, { phase: "failed", error: message });
        say(i, "✗ " + message);
        return false;
      }
      update(i, { prepared });
      say(i, `agent ${prepared.agent}`);
      say(i, `prompt ${prepared.promptRef} · sealed`);
    } else {
      say(i, `reusing agent ${prepared.agent} — already prepared`);
    }

    try {
      const receipt = await mintCapsule(
        { walletClient, publicClient, minter: minter as Address, prepared },
        (phase, detail) => {
          if (phase === "simulating") {
            update(i, { phase: "simulating" });
            say(i, "eth_call · would this mint revert?");
          } else if (phase === "signing") {
            update(i, { phase: "signing" });
            say(i, "no revert · sign the mint");
          } else {
            update(i, { phase: "mining" });
            say(i, `sent ${detail}`);
          }
        }
      );
      update(i, { phase: "done", receipt, error: null });
      say(i, `CapsuleMinted · token ${receipt.tokenId} · block ${receipt.blockNumber}`);
      say(i, `${receipt.gasUsed.toLocaleString()} gas · ${draft.slug}.${PARENT_NAME} is live on chain`);
      onMinted({ draft, prepared, receipt });
      return true;
    } catch (error) {
      const message = error instanceof MintError ? error.message : "the mint failed";
      update(i, { phase: "failed", error: message });
      say(i, "✗ " + message);
      return false;
    }
  }

  /** Runs every unminted capsule in order, stopping at the first failure. */
  async function runAll() {
    for (let i = 0; i < queue.length; i += 1) {
      // `runs` is this render's snapshot, which is the right one: a capsule is
      // visited at most once per pass, and a retry re-renders first.
      if (runs[i]?.receipt != null) continue;
      setActive(i);
      const ok = await runOne(i);
      if (!ok) break;
    }
    setActive(null);
  }

  const pending = runs.filter((r) => r.receipt === null).length;

  return (
    <div className="panel pad-lg">
      <div className="stepline">
        <span className="stepnum">04</span>
        <span className="tag">Mint</span>
      </div>
      <p className="stitle">One transaction does all four things</p>
      <p className="ssub">
        Without the minter this is four separate calls per agent. With it, the subname, the records and the heartbeat
        role land together — or none of them do. One signature and one transaction per capsule: the signature seals
        the prompt and the keys, because the mint needs the agent address they produce.
      </p>

      <div className="grid g-side">
        <div className="tile">
          <div className="label" style={{ marginBottom: 14 }}>
            In this transaction
          </div>
          <div className="stack">
            {[
              ["Register", queue.map((d) => d.slug).join(", ") + " under " + PARENT_NAME_DISPLAY],
              ["Hand you control", "every resolver role on the name, including the kill switch"],
              ["Write records", "9 keys per agent, read by the runner at boot"],
              ["Grant the role", RECORD_KEYS.heartbeat + " — the only thing the agent may write"],
              ["Emit CapsuleMinted", "so an indexer sees the whole mint in one event"],
            ].map(([a, b]) => (
              <div key={a} style={{ padding: "11px 0" }}>
                <div style={{ fontWeight: 700, fontSize: 14.5 }}>{a}</div>
                <div className="hint">{b}</div>
              </div>
            ))}
          </div>

          {allDone ? (
            <button className="btn btn-primary btn-block" style={{ marginTop: 18 }} onClick={done}>
              {doneCount + already === 1 ? "It is minted →" : `All ${doneCount + already} minted →`}
            </button>
          ) : (
            <button
              className="btn btn-primary btn-block"
              style={{ marginTop: 18 }}
              disabled={running || !chainOk || minter === null}
              onClick={() => void runAll()}
            >
              {running
                ? "Working…"
                : runs.some((r) => r.phase === "failed")
                  ? `Retry (${pending} left)`
                  : `Sign and mint ${queue.length === 1 ? "" : queue.length + " capsules"}`.trim()}
            </button>
          )}

          {doneCount + already > 0 && !allDone && (
            <button className="btn btn-sm btn-block btn-ghost" style={{ marginTop: 10 }} disabled={running} onClick={done}>
              Continue with the {doneCount + already} that minted →
            </button>
          )}

          <button className="btn btn-ghost btn-sm btn-block" style={{ marginTop: 10 }} disabled={running} onClick={back}>
            ← Back
          </button>

          {!chainOk && (
            <p className="hint" style={{ marginTop: 12 }}>
              Connect a wallet on {CHAIN.name} to sign.
            </p>
          )}
        </div>

        <div className="col" style={{ gap: 14 }}>
          {queue.map((d, i) => {
            const run = runs[i]!;
            return (
              <div key={d.slug} className="panel flat" style={{ overflow: "hidden" }}>
                <div
                  className="row"
                  style={{ padding: "10px 16px", background: "var(--paper)", borderBottom: "3px solid var(--ink)", gap: 10 }}
                >
                  <Capsule size={18} cap={d.cap} />
                  <span className="ensname" style={{ fontSize: 13 }}>
                    {d.slug}
                    <span className="p">.{PARENT_NAME_DISPLAY}</span>
                  </span>
                  <span className="push">
                    {run.phase === "done" ? (
                      <span className="pill run">
                        <span className="led" />
                        Minted
                      </span>
                    ) : run.phase === "failed" ? (
                      <span className="pill" style={{ borderColor: "var(--ink)" }}>
                        Failed
                      </span>
                    ) : run.phase === "idle" ? (
                      <span className="hint mono" style={{ fontSize: 11 }}>
                        queued
                      </span>
                    ) : (
                      <span className="pill wait">
                        <span className="led pulse" />
                        {run.phase}
                      </span>
                    )}
                  </span>
                </div>
                <pre className="term flush" style={{ minHeight: 92, fontSize: 11.5 }}>
                  {run.lines.map((l, k) => (
                    <span key={k} className={l.startsWith("✗") ? "y" : k === run.lines.length - 1 && run.phase === "done" ? "g" : "d"}>
                      {l}
                      {"\n"}
                    </span>
                  ))}
                  {active === i && run.phase !== "done" && <span className="caret" />}
                  {run.phase === "idle" && <span className="d">waiting…</span>}
                </pre>
                {run.receipt !== null && (
                  <div className="row" style={{ padding: "8px 16px", borderTop: "1px solid var(--line)" }}>
                    <a className="mono hint" style={{ fontSize: 11.5 }} href={txUrl(run.receipt.hash)} target="_blank" rel="noreferrer">
                      {shortHex(run.receipt.hash)} ↗
                    </a>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------------- 05 · provision ---------------- */

/**
 * Where the demo stops today.
 *
 * The names exist, their records are written and their agents hold the
 * heartbeat role — all of it verifiable on Sepolia right now. What does not
 * exist is a machine: nothing has called Fly, nothing has funded the agent
 * EOA, and no runner has booted. This screen used to animate exactly that
 * sequence, which made a mint look like a launch. It says what happened
 * instead.
 */
function StepProvision({ minted }: { minted: Minted[] }) {
  return (
    <div className="panel pad-lg">
      <div className="stepline">
        <span className="stepnum">05</span>
        <span className="tag">Provision</span>
      </div>
      <p className="stitle">{minted.length === 1 ? "The name exists." : "The names exist."}</p>
      <p className="ssub">
        Every record below is on {CHAIN.name} and readable by anything that speaks ENS. The agent holds{" "}
        <span className="mono">{RECORD_KEYS.heartbeat}</span> and nothing else, and you hold every other role —
        including the one that takes that away.
      </p>

      <div className="grid g2">
        {minted.map(({ draft, prepared, receipt }) => (
          <div key={draft.slug} className="tile">
            <div className="row" style={{ gap: 12, marginBottom: 14 }}>
              <Capsule size={38} cap={draft.cap} />
              <div style={{ minWidth: 0 }}>
                <div className="ensname" style={{ fontSize: 14.5 }}>
                  {draft.slug}
                  <span className="p">.{PARENT_NAME_DISPLAY}</span>
                </div>
                <div className="hint">{prepared.config.model}</div>
              </div>
              <span className="push">
                <span className="pill">never booted</span>
              </span>
            </div>
            <pre className="term" style={{ fontSize: 11.5, lineHeight: 1.8 }}>
              <span className="d">token </span>
              <span className="w">{receipt.tokenId.toString()}</span>
              {"\n"}
              <span className="d">node </span>
              <span className="w">{shortHex(receipt.node)}</span>
              {"\n"}
              <span className="d">addr </span>
              <span className="w">{prepared.agent}</span>
              {"\n"}
              <span className="d">{RECORD_KEYS.prompt} </span>
              <span className="y">{prepared.promptRef}</span>
              {"\n"}
              <span className="d">{RECORD_KEYS.endpointWeb} </span>
              <span className="w">{prepared.config.telegramUrl || "—"}</span>
              {"\n"}
              <span className="d">block </span>
              <span className="g">{receipt.blockNumber.toString()}</span>
            </pre>
            <a className="mono hint" style={{ fontSize: 11.5 }} href={txUrl(receipt.hash)} target="_blank" rel="noreferrer">
              {shortHex(receipt.hash)} ↗
            </a>
          </div>
        ))}
      </div>

      <div className="notice" style={{ marginTop: 22, borderColor: "var(--line)" }}>
        <span className="tag">Not done yet</span>
        <p style={{ margin: 0 }}>
          No machine is running. Provisioning — funding each agent&rsquo;s wallet for its heartbeat and starting its
          runner on Fly — is a separate step and the launchpad does not do it yet, so these capsules will show as{" "}
          <span className="mono">never-booted</span> on the fleet until a runner is started for them by hand.
        </p>
      </div>

      <div className="row" style={{ marginTop: 24, gap: 10 }}>
        <Link href="/fleet" className="btn btn-primary">
          Open the fleet →
        </Link>
        <Link href="/analyst" className="btn btn-sm btn-ghost push">
          Ask the analyst what just happened
        </Link>
      </div>
    </div>
  );
}
