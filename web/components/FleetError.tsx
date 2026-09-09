import Link from "next/link";

/* The fleet page reads a chain over the network, and that can fail. When it
   does, saying which variable or which RPC is a better demo than a 500 — and a
   far better one than falling back to fixtures, which would put invented
   capsules on a dashboard whose entire claim is that it invents nothing. */

export default function FleetError({ error }: { error: string }) {
  return (
    <main className="page">
      <div className="wrap">
        <p className="kicker" style={{ margin: 0 }}>
          Fleet
        </p>
        <h2 style={{ fontSize: 32, marginTop: 6 }}>The chain read failed</h2>
        <p className="hint" style={{ marginTop: 6, maxWidth: "62ch" }}>
          Nothing is rendered from fixtures here, so there is nothing to show. The fleet is whatever{" "}
          <span className="mono">CapsuleMinted</span> says it is, and that query did not come back.
        </p>

        <div className="panel pad" style={{ marginTop: 22, borderColor: "var(--alarm)" }}>
          <div className="label">What went wrong</div>
          <pre className="term" style={{ marginTop: 10 }}>
            <span className="r">{error}</span>
          </pre>
        </div>

        <div className="notice paper" style={{ marginTop: 22 }}>
          <span className="tag ink">Check</span>
          <p style={{ margin: 0 }}>
            <span className="mono">SEPOLIA_RPC_URL</span>, <span className="mono">CAPSULE_MINTER_ADDRESS</span> and{" "}
            <span className="mono">CAPSULE_MINTER_BLOCK</span> in <span className="mono">.env.local</span>. Run{" "}
            <span className="mono">npm run check:fleet</span> to test the read path on its own.
          </p>
        </div>

        <Link href="/" className="btn" style={{ marginTop: 22 }}>
          ← Home
        </Link>
      </div>
    </main>
  );
}
