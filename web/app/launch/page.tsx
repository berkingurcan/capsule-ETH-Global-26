"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Capsule from "@/components/Capsule";
import { MINT_PRICE, PARENT, ROLES, usd, type Role } from "@/lib/mock";

/* ------------------------------------------------------------------
   The launchpad. Six steps, one form — the order matters: secrets are
   entered before payment so the runner has everything it needs the
   moment the mint lands, and the record only ever holds a pointer.
   Nothing here signs anything; it is a design demo.
   ------------------------------------------------------------------ */

const STEPS = ["Parent", "Roles", "Configure", "Pay", "Mint", "Live"];

const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
const ALL_TOOLS = ["price", "swap", "repo", "diff", "draft", "schedule", "search", "notify"];

type Draft = {
  slug: string;
  title: string;
  cap: string;
  model: string;
  tools: string[];
  prompt: string;
  price: string;
  token: string;
  key: string;
};

function draftFrom(r: Role): Draft {
  return {
    slug: r.slug,
    title: r.title,
    cap: r.cap,
    model: r.model,
    tools: [...r.tools],
    prompt: r.prompt,
    price: "0.10",
    token: "8412996731:AAH" + r.slug.slice(0, 3) + "x9Qd7Lm2pR",
    key: "sk-ant-" + r.slug + "-••••••••••••",
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

  const total = picked.length * MINT_PRICE;

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
          {step > 0 && step < 5 && (
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
            total={total}
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

        {step === 3 && <StepPay drafts={drafts} total={total} back={() => setStep(2)} next={() => setStep(4)} />}

        {step === 4 && <StepMint drafts={drafts} next={() => setStep(5)} />}

        {step === 5 && <StepLive drafts={drafts} />}
      </div>
    </main>
  );
}

/* ---------------- 01 · parent ---------------- */

function StepParent({ next }: { next: () => void }) {
  const checks = [
    ["You own it", "ETHRegistry says 0x7a1c…9e40"],
    ["Subregistry is live", "deployed by the Verifiable Factory"],
    ["Resolver is set", "PublicResolverV2, EAC enabled"],
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
  total,
  back,
  next,
}: {
  picked: string[];
  toggle: (r: Role) => void;
  custom: string;
  setCustom: (v: string) => void;
  total: number;
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
        <div style={{ textAlign: "right" }}>
          <div className="label">Total</div>
          <div className="figure" style={{ fontSize: 20 }}>
            {usd(total)} USDC
          </div>
        </div>
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
              agent.model
            </label>
            <select id="model" className="select" value={d.model} onChange={(e) => patch(i, { model: e.target.value })}>
              {MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <span className="label">agent.tools</span>
            <div className="row wrapflex" style={{ gap: 7 }}>
              {ALL_TOOLS.map((t) => {
                const on = d.tools.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    className="tag"
                    aria-pressed={on}
                    style={{
                      border: on ? "2px solid var(--ink)" : "2px solid var(--line)",
                      background: on ? "var(--mint)" : "transparent",
                      color: on ? "var(--ink)" : "var(--muted)",
                      cursor: "pointer",
                    }}
                    onClick={() =>
                      patch(i, { tools: on ? d.tools.filter((x) => x !== t) : [...d.tools, t] })
                    }
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor="prompt">
              agent.prompt
            </label>
            <textarea
              id="prompt"
              className="textarea"
              value={d.prompt}
              onChange={(e) => patch(i, { prompt: e.target.value })}
            />
            <span className="hint">
              Change this later and the agent picks it up within 30 seconds. No redeploy.
            </span>
          </div>

          <div className="field" style={{ maxWidth: 220 }}>
            <label className="label" htmlFor="price">
              agent.price · USDC per call
            </label>
            <input id="price" className="input" value={d.price} onChange={(e) => patch(i, { price: e.target.value })} />
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
            <label className="label" htmlFor="key">
              Model API key
            </label>
            <input id="key" className="input" type="password" value={d.key} onChange={(e) => patch(i, { key: e.target.value })} />
          </div>

          <div className="tile shell">
            <div className="label" style={{ marginBottom: 10 }}>
              What lands in the record
            </div>
            <pre className="term" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
              <span className="d">addr </span>
              <span className="w">0x7a2f…6b09</span>
              {"\n"}
              <span className="d">agent.model </span>
              <span className="w">{d.model}</span>
              {"\n"}
              <span className="d">agent.tools </span>
              <span className="w">{d.tools.join(",") || "—"}</span>
              {"\n"}
              <span className="d">agent.price </span>
              <span className="w">{d.price}</span>
              {"\n"}
              <span className="d">agent.secrets </span>
              <span className="y">cap_8f3d1a</span>
              {"\n"}
              <span className="d">agent.heartbeat </span>
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
          Continue to payment →
        </button>
      </div>
    </div>
  );
}

/* ---------------- 04 · x402 ---------------- */

const HANDSHAKE = [
  { d: "→ ", w: "POST", t: " /deploy HTTP/1.1" },
  { d: "← ", y: "402 Payment Required" },
  { d: "   x-402-price: ", w: "AMOUNT USDC" },
  { d: "   x-402-network: ", w: "base-sepolia" },
  { d: "   x-402-recipient: ", w: "capsule.eth" },
  { d: "→ ", w: "POST", t: " /deploy HTTP/1.1" },
  { d: "   X-PAYMENT: ", p: "eip3009 0x9f2e…bc71" },
  { d: "← ", g: "200 OK", t: "  · settled in 183 ms" },
];

function StepPay({
  drafts,
  total,
  back,
  next,
}: {
  drafts: Draft[];
  total: number;
  back: () => void;
  next: () => void;
}) {
  const [n, setN] = useState(0);
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    if (!paying) return;
    if (n >= HANDSHAKE.length) {
      const t = setTimeout(next, 900);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setN((x) => x + 1), n === 1 ? 700 : 320);
    return () => clearTimeout(t);
  }, [paying, n, next]);

  return (
    <div className="panel pad-lg">
      <div className="stepline">
        <span className="stepnum">04</span>
        <span className="tag sun">x402 checkout</span>
      </div>
      <p className="stitle">Pay in the request, not in a modal</p>
      <p className="ssub">
        The deploy endpoint answers <span className="mono">402 Payment Required</span>. Your wallet signs a gasless
        EIP-3009 authorisation, the retry carries it in a header, and the facilitator settles on Base Sepolia. One
        signature covers every agent in the order.
      </p>

      <div className="grid g-side">
        <div className="tile">
          <div className="label" style={{ marginBottom: 12 }}>
            Order
          </div>
          {drafts.map((d) => (
            <div key={d.slug} className="kv">
              <span className="ensname" style={{ fontSize: 13.5 }}>
                {d.slug}
                <span className="p">.{PARENT.name}</span>
              </span>
              <span className="figure" style={{ fontSize: 14 }}>
                {usd(MINT_PRICE)}
              </span>
            </div>
          ))}
          <div className="kv" style={{ paddingTop: 14 }}>
            <b>Total</b>
            <span className="figure" style={{ fontSize: 24 }}>
              {usd(total)} USDC
            </span>
          </div>
          <p className="hint" style={{ margin: "6px 0 16px" }}>
            No approval transaction and no gas — the signature is the payment.
          </p>
          <button className="btn btn-primary btn-block" disabled={paying} onClick={() => setPaying(true)}>
            {paying ? "Settling…" : "Sign & pay " + usd(total) + " USDC"}
          </button>
        </div>

        <div className="panel flat" style={{ overflow: "hidden" }}>
          <div className="row" style={{ padding: "12px 18px", background: "var(--paper)", borderBottom: "3px solid var(--ink)" }}>
            <span className="label">Live handshake</span>
            {n >= HANDSHAKE.length ? (
              <span className="pill run push">
                <span className="led" />
                183 ms
              </span>
            ) : (
              <span className="pill quiet push">idle</span>
            )}
          </div>
          <pre className="term flush" style={{ minHeight: 236 }}>
            {HANDSHAKE.slice(0, n).map((l, k) => (
              <span key={k}>
                <span className="d">{l.d}</span>
                {l.w && <span className="w">{l.w.replace("AMOUNT", usd(total))}</span>}
                {l.y && <span className="y">{l.y}</span>}
                {l.g && <span className="g">{l.g}</span>}
                {l.p && <span className="p">{l.p}</span>}
                {l.t && <span className="d">{l.t}</span>}
                {"\n"}
              </span>
            ))}
            {paying && n < HANDSHAKE.length && <span className="caret" />}
            {!paying && <span className="d">waiting for the first request…</span>}
          </pre>
        </div>
      </div>

      <div className="row" style={{ marginTop: 26 }}>
        <button className="btn btn-ghost btn-sm" onClick={back} disabled={paying}>
          ← Back
        </button>
      </div>
    </div>
  );
}

/* ---------------- 05 · mint ---------------- */

function StepMint({ drafts, next }: { drafts: Draft[]; next: () => void }) {
  const [n, setN] = useState(0);
  const [signing, setSigning] = useState(false);
  const lines = useMemo(
    () => [
      "CapsuleMinter.mintAgent() ×" + drafts.length,
      "register subname under berkin.eth",
      "setText ×6 per agent · model, tools, prompt, endpoint, price, secrets",
      "grantRoles(resource, agent, ROLE_HEARTBEAT)",
      "emit AgentMinted",
      "confirmed · block 7412903",
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
        <span className="stepnum">05</span>
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
              ["Write records", "6 keys per agent, read by the runner at boot"],
              ["Grant the role", "agent.heartbeat — the only thing the agent may write"],
              ["Emit AgentMinted", "so the subgraph sees it in one event"],
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
        </div>

        <div className="panel flat" style={{ overflow: "hidden" }}>
          <div className="row" style={{ padding: "12px 18px", background: "var(--paper)", borderBottom: "3px solid var(--ink)" }}>
            <span className="label">ETH Sepolia</span>
            <span className="push mono hint" style={{ fontSize: 11.5 }}>
              CapsuleMinter 0x9c31…04af
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

/* ---------------- 06 · live ---------------- */

const BOOT = [
  "machine created · region ord",
  "pulling capsule/runner:latest",
  "resolved NAME · 6 records",
  "secrets cap_8f3d1a unsealed",
  "telegram bot online",
  "first heartbeat written",
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
        <span className="stepnum">06</span>
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
                  {l.replace("NAME", d.slug + ".berkin.eth")}
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
            <span className="mono">agent.prompt</span> in the record and it becomes a different agent within 30
            seconds, with no redeploy.
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
