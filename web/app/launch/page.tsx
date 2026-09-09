"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Capsule from "@/components/Capsule";
import { RECORD_KEYS } from "@/lib/capsule/records";
import { PARENT, ROLES, type Role } from "@/lib/mock";
import {
  PROVIDERS,
  PROVIDER_IDS,
  SUGGESTED_MODELS,
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

   Nothing here signs anything yet; it is still a design demo.
   ------------------------------------------------------------------ */

const STEPS = ["Parent", "Roles", "Configure", "Mint", "Live"];

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
  token: string;
  /**
   * One API key per provider, not one per capsule.
   *
   * A single unlabelled key would work exactly until the owner changed
   * `agent-model` to a different provider — at which point the agent would go
   * quiet, which is what a recall looks like. Storing them by provider is what
   * makes "change the record, change the brain" survive a provider change.
   */
  keys: Partial<Record<ProviderId, string>>;
};

/** The provider half of a draft's model reference. */
function providerOf(draft: Draft): ProviderId | undefined {
  const parsed = parseModelRef(draft.model);
  if (parsed === null) return undefined;
  return PROVIDER_IDS.find((id) => id === parsed.provider);
}

/** True when this draft names a model it has no key to run. */
function missingKey(draft: Draft): ProviderId | undefined {
  const provider = providerOf(draft);
  if (provider === undefined) return undefined;
  const key = draft.keys[provider];
  return key === undefined || key.trim() === "" ? provider : undefined;
}

function draftFrom(r: Role): Draft {
  return {
    slug: r.slug,
    title: r.title,
    cap: r.cap,
    model: r.model,
    context: r.context,
    prompt: r.prompt,
    token: "8412996731:AAH" + r.slug.slice(0, 3) + "x9Qd7Lm2pR",
    keys: { [parseModelRef(r.model)?.provider as ProviderId]: "••••••••••••••••" },
  };
}

export default function LaunchPage() {
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<string[]>(["trader", "dev"]);
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    ROLES.filter((r) => ["trader", "dev"].includes(r.slug)).map(draftFrom)
  );
  const [tab, setTab] = useState(0);
  const [custom, setCustom] = useState("");

  function toggle(r: Role) {
    if (r.taken) return;
    setPicked((p) => {
      const next = p.includes(r.slug) ? p.filter((s) => s !== r.slug) : [...p, r.slug];
      setDrafts((d) => {
        const keep = d.filter((x) => next.includes(x.slug));
        const added = next.filter((s) => !keep.some((k) => k.slug === s));
        const made = added.map((s) => draftFrom(ROLES.find((x) => x.slug === s)!));
        return [...keep, ...made].sort((a, b) => next.indexOf(a.slug) - next.indexOf(b.slug));
      });
      return next;
    });
    setTab(0);
  }

  function patch(i: number, p: Partial<Draft>) {
    setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...x, ...p } : x)));
  }

  return (
    <main className="page">
      <div className="wrap wrap-narrow">
        <div className="spread wrapflex" style={{ marginBottom: 20 }}>
          <div>
            <p className="kicker" style={{ margin: 0 }}>
              Launchpad
            </p>
            <h2 style={{ fontSize: 30, marginTop: 6 }}>Hire an agent under {PARENT.name}</h2>
          </div>
          {step > 0 && step < 4 && (
            <button className="btn btn-sm btn-ghost" onClick={() => setStep(0)}>
              Restart demo
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

        {step === 0 && <StepParent next={() => setStep(1)} />}

        {step === 1 && (
          <StepRoles
            picked={picked}
            toggle={toggle}
            custom={custom}
            setCustom={setCustom}
            back={() => setStep(0)}
            next={() => setStep(2)}
          />
        )}

        {step === 2 && (
          <StepConfigure
            drafts={drafts}
            tab={tab}
            setTab={setTab}
            patch={patch}
            back={() => setStep(1)}
            next={() => setStep(3)}
          />
        )}

        {step === 3 && <StepMint drafts={drafts} back={() => setStep(2)} next={() => setStep(4)} />}

        {step === 4 && <StepLive drafts={drafts} />}
      </div>
    </main>
  );
}

/* ---------------- 01 · parent ---------------- */

function StepParent({ next }: { next: () => void }) {
  const checks = [
    ["You own it", "ETHRegistry says 0x7a1c…9e40"],
    ["Subregistry is live", "deployed by the Verifiable Factory"],
    ["Resolver is set", "PermissionedResolver, EAC enabled"],
    ["Capsule can write below it", "admin role on the subregistry only"],
  ];

  return (
    <div className="panel pad-lg">
      <div className="stepline">
        <span className="stepnum">01</span>
        <span className="tag">Connect parent</span>
      </div>
      <p className="stitle">Connect the name that will do the hiring</p>
      <p className="ssub">
        Capsule mints subnames underneath a name you already own. It never takes custody of the parent, and it can
        only write below it.
      </p>

      <div className="grid g-side" style={{ alignItems: "stretch" }}>
        <div className="tile shell" style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
          <Capsule size={64} cap="#1B4FD8" />
          <div style={{ minWidth: 0 }}>
            <div className="ensname" style={{ fontSize: 24 }}>
              {PARENT.name}
            </div>
            <div className="mono" style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4 }}>
              0x7a1c…9e40 · owner
            </div>
            <div className="row wrapflex" style={{ gap: 7, marginTop: 12 }}>
              <span className="tag">ENSv2 registry</span>
              <span className="tag">Sepolia</span>
            </div>
          </div>
          <span className="pill run push">
            <span className="led" />
            Verified
          </span>
        </div>

        <div className="tile">
          <div className="label" style={{ marginBottom: 12 }}>
            What Capsule checked
          </div>
          <div className="stack">
            {checks.map(([a, b]) => (
              <div key={a} className="row-top" style={{ gap: 10, padding: "10px 0" }}>
                <span className="check on" style={{ width: 20, height: 20, borderWidth: 2.5, fontSize: 11, background: "var(--mint)" }}>
                  ✓
                </span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{a}</div>
                  <div className="hint mono" style={{ fontSize: 11.5 }}>
                    {b}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 26, gap: 10 }}>
        <button className="btn btn-ghost btn-sm">Use a different name</button>
        <button className="btn btn-primary push" onClick={next}>
          Pick roles →
        </button>
      </div>
    </div>
  );
}

/* ---------------- 02 · roles ---------------- */

function StepRoles({
  picked,
  toggle,
  custom,
  setCustom,
  back,
  next,
}: {
  picked: string[];
  toggle: (r: Role) => void;
  custom: string;
  setCustom: (v: string) => void;
  back: () => void;
  next: () => void;
}) {
  return (
    <div className="panel pad-lg">
      <div className="stepline">
        <span className="stepnum">02</span>
        <span className="tag">Select subnames</span>
      </div>
      <p className="stitle">Pick the roles you want to hire</p>
      <p className="ssub">
        Each role becomes a subname under <span className="mono">{PARENT.name}</span>. The label is the job — and
        because the agent reads its own name at boot, the label is also half its configuration.
      </p>

      <div className="grid g3">
        {ROLES.map((r) => {
          const on = picked.includes(r.slug);
          return (
            <button
              key={r.slug}
              type="button"
              className={"pick" + (on ? " on" : "") + (r.taken ? " taken" : "")}
              onClick={() => toggle(r)}
              disabled={r.taken}
              aria-pressed={on}
            >
              <div className="row" style={{ gap: 12 }}>
                <Capsule size={40} cap={r.taken ? "#C4D5F6" : r.cap} shell={r.taken ? "#E4EBFA" : "#F2F6FF"} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{r.title}</div>
                  <div className="hint" style={{ fontSize: 12.5 }}>
                    {r.taken ? "already minted" : r.blurb}
                  </div>
                </div>
                <span className={"check push" + (on ? " on" : "")} style={on ? { background: r.cap } : undefined}>
                  ✓
                </span>
              </div>
              <div className="ensname" style={{ fontSize: 13.5 }}>
                {r.slug}
                <span className="p">.{PARENT.name}</span>
              </div>
            </button>
          );
        })}

        <div className="pick" style={{ borderStyle: "dashed", cursor: "default" }}>
          <div className="label">Custom role</div>
          <input
            className="input"
            placeholder="ops"
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/[^a-z0-9-]/g, ""))}
            aria-label="Custom role label"
          />
          <div className="hint" style={{ fontSize: 12.5 }}>
            {custom ? (
              <span style={{ color: "var(--mint-700)", fontWeight: 600 }}>
                {custom}.{PARENT.name} is free
              </span>
            ) : (
              "Checked against the subregistry as you type."
            )}
          </div>
        </div>
      </div>

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
  tab,
  setTab,
  patch,
  back,
  next,
}: {
  drafts: Draft[];
  tab: number;
  setTab: (i: number) => void;
  patch: (i: number, p: Partial<Draft>) => void;
  back: () => void;
  next: () => void;
}) {
  const d = drafts[Math.min(tab, drafts.length - 1)];
  const i = Math.min(tab, drafts.length - 1);
  const missing = missingKey(d);

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
        {drafts.map((x, j) => (
          <button
            key={x.slug}
            className={"btn btn-sm" + (j === i ? "" : " btn-ghost")}
            style={j === i ? { background: x.cap } : undefined}
            onClick={() => setTab(j)}
          >
            <Capsule size={16} cap={x.cap} />
            {x.slug}
          </button>
        ))}
      </div>

      <div className="grid g-side">
        <div className="col" style={{ gap: 18 }}>
          <div className="field">
            <label className="label" htmlFor="model">
              agent-model
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
            <input id="tg" className="input" type="password" value={d.token} onChange={(e) => patch(i, { token: e.target.value })} />
            <span className="hint">From @BotFather. This is how you will talk to the agent.</span>
          </div>

          <div className="field">
            <span className="label">Provider API keys</span>
            <span className="hint" style={{ marginBottom: 10 }}>
              One per provider, not one per agent. Give it a key for every provider you may want to
              switch to — swapping <span className="mono">agent-model</span> to a provider with no key
              stored stops the agent until you add one.
            </span>

            <div className="col" style={{ gap: 10 }}>
              {PROVIDER_IDS.map((id) => {
                const spec = PROVIDERS[id];
                const active = providerOf(d) === id;
                return (
                  <div key={id} className="row" style={{ gap: 8, alignItems: "center" }}>
                    <label
                      className="mono"
                      htmlFor={`key-${id}`}
                      style={{
                        width: 132,
                        fontSize: 11,
                        color: active ? "var(--ink)" : "var(--muted)",
                        fontWeight: active ? 600 : 400,
                      }}
                      title={spec.envVar}
                    >
                      {spec.envVar}
                    </label>
                    <input
                      id={`key-${id}`}
                      className="input"
                      type="password"
                      placeholder={spec.keyHint}
                      value={d.keys[id] ?? ""}
                      onChange={(e) => patch(i, { keys: { ...d.keys, [id]: e.target.value } })}
                      style={{ flex: 1 }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {missing !== undefined && (
            <div className="notice" style={{ borderColor: "var(--line)" }}>
              <span className="tag">Heads up</span>
              <p style={{ margin: 0 }}>
                No key stored for <span className="mono">{missing}</span>. This capsule will mint, but it
                cannot start on <span className="mono">{d.model}</span> until you add one — and an agent
                that will not start looks exactly like an agent that was recalled.
              </p>
            </div>
          )}

          <div className="tile shell">
            <div className="label" style={{ marginBottom: 10 }}>
              What lands in the record
            </div>
            <pre className="term" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
              <span className="d">addr </span>
              <span className="w">0x7a2f…6b09</span>
              {"\n"}
              <span className="d">agent-model </span>
              <span className="w">{d.model}</span>
              {"\n"}
              <span className="d">agent-runtime </span>
              <span className="w">openclaw</span>
              {"\n"}
              <span className="d">agent-prompt </span>
              <span className="y">cap_8f3d1a</span>
              {"\n"}
              <span className="d">agent-heartbeat </span>
              <span className="g">written by the agent</span>
            </pre>
          </div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 26, gap: 10 }}>
        <button className="btn btn-ghost btn-sm" onClick={back}>
          ← Back
        </button>
        <button className="btn btn-primary push" onClick={next}>
          Continue to mint →
        </button>
      </div>
    </div>
  );
}

/* ---------------- 04 · mint ---------------- */

function StepMint({ drafts, back, next }: { drafts: Draft[]; back: () => void; next: () => void }) {
  const [n, setN] = useState(0);
  const [signing, setSigning] = useState(false);
  const lines = useMemo(
    () => [
      "CapsuleMinter.mint() ×" + drafts.length,
      "register subname under " + PARENT.name,
      "authorizeNameRoles(owner) · you keep the kill switch",
      "setAddr + setText ×9 per agent · ENSIP-25/26/27",
      "authorizeTextRoles(" + RECORD_KEYS.heartbeat + ", agent, true)",
      "emit CapsuleMinted",
      "confirmed · block 11662631",
    ],
    [drafts.length]
  );

  useEffect(() => {
    if (!signing) return;
    if (n >= lines.length) {
      const t = setTimeout(next, 900);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setN((x) => x + 1), 450);
    return () => clearTimeout(t);
  }, [signing, n, lines.length, next]);

  return (
    <div className="panel pad-lg">
      <div className="stepline">
        <span className="stepnum">04</span>
        <span className="tag">Mint</span>
      </div>
      <p className="stitle">One transaction does all four things</p>
      <p className="ssub">
        Without the minter this is four separate calls per agent. With it, the subname, the records and the heartbeat
        role land together — or none of them do.
      </p>

      <div className="grid g-side">
        <div className="tile">
          <div className="label" style={{ marginBottom: 14 }}>
            In this transaction
          </div>
          <div className="stack">
            {[
              ["Register", drafts.map((d) => d.slug).join(", ") + " under " + PARENT.name],
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
          <button className="btn btn-primary btn-block" style={{ marginTop: 18 }} disabled={signing} onClick={() => setSigning(true)}>
            {signing ? "Minting…" : "Sign the mint"}
          </button>
          <button className="btn btn-ghost btn-sm btn-block" style={{ marginTop: 10 }} disabled={signing} onClick={back}>
            ← Back
          </button>
        </div>

        <div className="panel flat" style={{ overflow: "hidden" }}>
          <div className="row" style={{ padding: "12px 18px", background: "var(--paper)", borderBottom: "3px solid var(--ink)" }}>
            <span className="label">ETH Sepolia</span>
            <span className="push mono hint" style={{ fontSize: 11.5 }}>
              CapsuleMinter 0xe609…a362
            </span>
          </div>
          <pre className="term flush" style={{ minHeight: 236 }}>
            {lines.slice(0, n).map((l, k) => (
              <span key={k} className={k === lines.length - 1 ? "g" : k === 0 ? "w" : "d"}>
                {k === 0 ? "→ " : "  "}
                {l}
                {"\n"}
              </span>
            ))}
            {signing && n < lines.length && <span className="caret" />}
            {!signing && <span className="d">waiting for signature…</span>}
          </pre>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 05 · live ---------------- */

const BOOT = [
  "machine created · region ord",
  "pulling capsule/runner:latest",
  "resolved NAME · 9 records",
  "prompt cap_8f3d1a unsealed · openclaw gateway up",
  "telegram bot online",
  "beat-1 written · 47,639 gas",
];

function StepLive({ drafts }: { drafts: Draft[] }) {
  const [n, setN] = useState(0);
  const done = n >= BOOT.length;

  useEffect(() => {
    if (done) return;
    const t = setTimeout(() => setN((x) => x + 1), 700);
    return () => clearTimeout(t);
  }, [n, done]);

  return (
    <div className="panel pad-lg">
      <div className="stepline">
        <span className="stepnum">05</span>
        <span className="tag mint">Provision</span>
      </div>
      <p className="stitle">{done ? "They are awake." : "Booting the runners"}</p>
      <p className="ssub">
        Each agent gets the same container with two environment variables: its own name, and a reference to its
        secrets. Everything else it learns by reading itself.
      </p>

      <div className="grid g2">
        {drafts.map((d) => (
          <div key={d.slug} className="tile">
            <div className="row" style={{ gap: 12, marginBottom: 14 }}>
              <Capsule size={38} cap={d.cap} />
              <div>
                <div className="ensname" style={{ fontSize: 14.5 }}>
                  {d.slug}
                  <span className="p">.{PARENT.name}</span>
                </div>
                <div className="hint">{d.model}</div>
              </div>
              <span className="push">
                {done ? (
                  <span className="pill run">
                    <span className="led" />
                    Running
                  </span>
                ) : (
                  <span className="pill wait">
                    <span className="led pulse" />
                    Booting
                  </span>
                )}
              </span>
            </div>
            <pre className="term" style={{ fontSize: 11.5, minHeight: 150 }}>
              {BOOT.slice(0, n).map((l, k) => (
                <span key={k} className={k === BOOT.length - 1 ? "g" : "d"}>
                  {l.replace("NAME", d.slug + "." + PARENT.name)}
                  {"\n"}
                </span>
              ))}
              {!done && <span className="caret" />}
            </pre>
          </div>
        ))}
      </div>

      {done && (
        <div className="notice mint" style={{ marginTop: 22 }}>
          <span className="tag ink">Next</span>
          <p style={{ margin: 0 }}>
            Message the bot on Telegram and it already knows what it is — it read its own name. Change{" "}
            <span className="mono">{RECORD_KEYS.prompt}</span> in the record and it becomes a different agent
            within 30 seconds, with no redeploy.
          </p>
        </div>
      )}

      <div className="row" style={{ marginTop: 24, gap: 10 }}>
        <Link href="/fleet" className="btn btn-primary" style={{ pointerEvents: done ? "auto" : "none", opacity: done ? 1 : 0.45 }}>
          Open the fleet →
        </Link>
        <Link href="/analyst" className="btn btn-sm btn-ghost push">
          Ask the analyst what just happened
        </Link>
      </div>
    </div>
  );
}
