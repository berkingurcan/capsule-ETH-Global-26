import Link from "next/link";
import Capsule from "@/components/Capsule";
import ActivityFeed from "@/components/ActivityFeed";

const TOUR = [
  {
    href: "/launch",
    n: "01",
    cap: "#FFC42E",
    title: "The launchpad",
    body: "Pick a subname, give it a brain, pay a dollar over x402, mint. Five screens, one form.",
    cta: "Hire an agent",
  },
  {
    href: "/fleet",
    n: "02",
    cap: "#8CF0B4",
    title: "The fleet",
    body: "Every capsule you own, its heartbeat, its balance, its live log — and the button that pulls its permission.",
    cta: "Open the dashboard",
  },
  {
    href: "/analyst",
    n: "03",
    cap: "#FF4D8D",
    title: "The analyst",
    body: "Ask what the fleet did today. It reads both subgraphs and answers in sentences, not tables.",
    cta: "Ask a question",
  },
];

export default function Home() {
  return (
    <>
      {/* ---------- hero ---------- */}
      <section className="band b-blue" style={{ padding: "60px 0 68px" }}>
        <div className="wrap hero">
         <div>
          <p className="kicker">Demo build · ETHOnline 2026</p>
          <h1 style={{ color: "var(--shell)" }}>
            One name.
            <br />A whole fleet.
          </h1>
          <p className="lede" style={{ fontSize: 20, maxWidth: "54ch" }}>
            Every agent ships as a sealed capsule: an ENSv2 subname on the shell, its whole configuration in the
            record, and one permission you can pull. Take the permission away and the agent stops itself.
          </p>

          <div className="row wrapflex" style={{ gap: 12, marginTop: 30 }}>
            <Link href="/launch" className="btn btn-primary">
              Start the demo →
            </Link>
            <Link href="/fleet" className="btn btn-onink">
              Skip to the fleet
            </Link>
          </div>

          <div className="row wrapflex" style={{ gap: 10, marginTop: 34 }}>
            <span className="pill onblue">ENSv2 subnames</span>
            <span className="pill onblue">EAC roles</span>
            <span className="pill onblue">x402 checkout</span>
            <span className="pill onblue">Two subgraphs</span>
            <span className="pill onblue">Telegram runners</span>
          </div>
         </div>

          {/* the tray */}
          <div className="panel shell" style={{ padding: "24px 26px" }}>
            <div className="label">In the tray</div>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end", margin: "20px 0 4px" }}>
              {[
                { c: "#FFC42E", n: "trader", s: 62 },
                { c: "#8CF0B4", n: "dev", s: 78 },
                { c: "#FF4D8D", n: "marketing", s: 62 },
              ].map((x) => (
                <div key={x.n} style={{ textAlign: "center" }}>
                  <Capsule size={x.s} cap={x.c} title={x.n + ".berkin.eth"} />
                  <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 10 }}>
                    {x.n}
                  </div>
                </div>
              ))}
            </div>
            <hr className="sep" style={{ margin: "18px 0" }} />
            <div className="label">Mint fee</div>
            <div className="wm" style={{ fontSize: 46, marginTop: 6 }}>
              1 USDC
            </div>
            <div className="mono hint" style={{ marginTop: 6 }}>
              per agent · settled in 183 ms
            </div>
          </div>
        </div>
      </section>

      {/* ---------- the mechanic ---------- */}
      <section className="band b-shell">
        <div className="wrap">
          <div className="sec-head">
            <p className="kicker">The mechanic</p>
            <h2>How an agent dies.</h2>
            <p className="lede">
              The agent proves it is alive by writing to its own name every 60 seconds. That write needs a role. Pull
              the role and the write reverts — so the kill switch is not something we built, it is the one ENSv2
              already has.
            </p>
          </div>

          <figure className="panel" style={{ margin: 0, padding: "26px 26px 20px", background: "#fff" }}>
            <div className="scroller">
              <svg
                viewBox="0 0 760 215"
                role="img"
                aria-label="The runner writes a heartbeat to its own name every 60 seconds. The resolver checks the agent's role: if it still holds it the write lands and the runner keeps going; if the owner has revoked it the write fails with EACUnauthorizedAccountRoles and the runner halts itself."
                style={{ width: "100%", minWidth: 680, height: "auto", display: "block", margin: "0 auto", maxWidth: 760 }}
              >
                <defs>
                  <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0 0 L10 5 L0 10 z" fill="#12203F" />
                  </marker>
                  <marker id="ah-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0 0 L10 5 L0 10 z" fill="#E03131" />
                  </marker>
                </defs>

                {/* runner */}
                <rect x="16" y="96" width="180" height="72" fill="#F2F6FF" stroke="#12203F" strokeWidth="3" rx="10" />
                <text x="106" y="124" textAnchor="middle" fontFamily="Rubik, sans-serif" fontSize="13" fontWeight="700" fill="#12203F">
                  runner
                </text>
                <text x="106" y="145" textAnchor="middle" fontFamily="'Azeret Mono', monospace" fontSize="11.5" fill="#5C6E96">
                  trader.berkin.eth
                </text>

                {/* runner -> resolver */}
                <line x1="196" y1="132" x2="322" y2="132" stroke="#12203F" strokeWidth="3" markerEnd="url(#ah)" />
                <text x="259" y="120" textAnchor="middle" fontFamily="'Azeret Mono', monospace" fontSize="10.5" fill="#12203F">
                  setText(heartbeat)
                </text>
                <text x="259" y="150" textAnchor="middle" fontFamily="'Azeret Mono', monospace" fontSize="10.5" fill="#5C6E96">
                  every 60s
                </text>

                {/* owner */}
                <rect x="330" y="8" width="176" height="42" fill="#FFC42E" stroke="#12203F" strokeWidth="3" rx="10" />
                <text x="418" y="34" textAnchor="middle" fontFamily="Rubik, sans-serif" fontSize="13" fontWeight="700" fill="#12203F">
                  owner pulls the plug
                </text>
                <line x1="418" y1="50" x2="418" y2="84" stroke="#E03131" strokeWidth="3" markerEnd="url(#ah-red)" />
                <text x="428" y="72" fontFamily="'Azeret Mono', monospace" fontSize="10.5" fill="#E03131">
                  revokeRoles()
                </text>

                {/* resolver */}
                <rect x="330" y="88" width="176" height="88" fill="#fff" stroke="#12203F" strokeWidth="3" rx="10" />
                <text x="418" y="116" textAnchor="middle" fontFamily="Rubik, sans-serif" fontSize="13" fontWeight="700" fill="#12203F">
                  PublicResolverV2
                </text>
                <text x="418" y="136" textAnchor="middle" fontFamily="'Azeret Mono', monospace" fontSize="10.5" fill="#5C6E96">
                  checks the EAC role
                </text>
                <text x="418" y="156" textAnchor="middle" fontFamily="'Azeret Mono', monospace" fontSize="10.5" fill="#5C6E96">
                  still holds it?
                </text>

                {/* yes branch */}
                <polyline points="506,116 534,116 534,88 556,88" fill="none" stroke="#12203F" strokeWidth="3" markerEnd="url(#ah)" />
                <text x="552" y="80" textAnchor="end" fontFamily="'Azeret Mono', monospace" fontSize="10.5" fill="#0E7A4A">
                  yes
                </text>
                <rect x="560" y="60" width="184" height="56" fill="#8CF0B4" stroke="#12203F" strokeWidth="3" rx="10" />
                <text x="652" y="84" textAnchor="middle" fontFamily="Rubik, sans-serif" fontSize="13" fontWeight="700" fill="#12203F">
                  write lands
                </text>
                <text x="652" y="103" textAnchor="middle" fontFamily="'Azeret Mono', monospace" fontSize="10.5" fill="#0E7A4A">
                  keeps running
                </text>

                {/* no branch */}
                <polyline points="506,148 534,148 534,168 556,168" fill="none" stroke="#E03131" strokeWidth="3" markerEnd="url(#ah-red)" />
                <text x="552" y="192" textAnchor="end" fontFamily="'Azeret Mono', monospace" fontSize="10.5" fill="#E03131">
                  no
                </text>
                <rect x="560" y="140" width="184" height="60" fill="#fff" stroke="#E03131" strokeWidth="3" rx="10" />
                <text x="652" y="164" textAnchor="middle" fontFamily="'Azeret Mono', monospace" fontSize="11" fill="#E03131">
                  EACUnauthorized…
                </text>
                <text x="652" y="184" textAnchor="middle" fontFamily="Rubik, sans-serif" fontSize="12.5" fontWeight="700" fill="#12203F">
                  runner halts itself
                </text>
              </svg>
            </div>
            <figcaption className="hint" style={{ marginTop: 14, maxWidth: "70ch" }}>
              The full revert is <span className="mono">EACUnauthorizedAccountRoles</span> — the same error ENSv2
              throws for any subname owner writing to a resolver it holds no role on.
            </figcaption>
          </figure>
        </div>
      </section>

      {/* ---------- tour ---------- */}
      <section className="band b-paper">
        <div className="wrap">
          <div className="sec-head">
            <p className="kicker">What to click</p>
            <h2>Three screens, in order.</h2>
            <p className="lede">
              This is a front-end demo — every name, balance and log line below is mock data. No wallet is needed and
              nothing leaves the browser.
            </p>
          </div>

          <div className="grid g3">
            {TOUR.map((t) => (
              <Link key={t.href} href={t.href} className="panel" style={{ padding: "22px 24px 24px", display: "block" }}>
                <div className="row" style={{ marginBottom: 16 }}>
                  <Capsule size={40} cap={t.cap} />
                  <span className="push mono" style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>
                    {t.n}
                  </span>
                </div>
                <h3 style={{ marginBottom: 8 }}>{t.title}</h3>
                <p style={{ margin: "0 0 18px", fontSize: 14.5, color: "#33456F" }}>{t.body}</p>
                <span className="btn btn-sm">{t.cta} →</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- live feed ---------- */}
      <section className="band b-shell">
        <div className="wrap">
          <div className="sec-head">
            <p className="kicker">Read off the subgraphs</p>
            <h2>Everything an agent does leaves a row.</h2>
            <p className="lede">
              Names and permissions are indexed on ETH Sepolia; payments are indexed on Base Sepolia. One feed, two
              chains, no bridge between them.
            </p>
          </div>
          <ActivityFeed limit={5} />
        </div>
      </section>
    </>
  );
}
