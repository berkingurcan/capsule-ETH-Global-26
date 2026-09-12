import RegisterName from "@/components/RegisterName";

/* ENS runs the deployment portal for this hackathon's Sepolia beta. It is the
   canonical place to get a name, so it goes first and this page's own form is
   offered as the fallback — see the note in components/RegisterName.tsx for why
   the fallback exists at all. */
const ENS_PORTAL = "https://hackathon-deployment-portal-app.ens-cf.workers.dev/";

/* No server shell to speak of, and that is the point.

   Every other write page in this app takes the minter address as a prop from
   `loadServerEnv()`, because it talks to a Capsule contract. This one does not:
   it talks to ENS's `ETHRegistrar` and to an ERC-20, both of which are fixed
   addresses on a fixed chain. There is nothing to inject and nothing that can
   drift, so the page is a client component with a heading — and it keeps working
   if Capsule's own configuration is missing entirely, which is exactly the state
   somebody standing here for the first time may be in. */
export const metadata = {
  title: "Register a name · Capsule",
  description: "Register a .eth name on the ENSv2 Sepolia beta, and mint the test token to pay for it.",
};

export default async function RegisterPage({
  searchParams,
}: {
  /* `?label=` is where /connect sends someone whose name turned out not to exist,
     so the form opens on the name they already typed rather than making them
     type it twice. Only a default for the field — availability and price are
     re-read from the chain before anything can be signed. */
  searchParams: Promise<{ label?: string }>;
}) {
  const { label } = await searchParams;

  return (
    <div className="page wrap">
      <div className="panel pad-lg" style={{ background: "var(--sun)", marginBottom: 22 }}>
        <div className="row wrapflex" style={{ gap: 12, marginBottom: 14 }}>
          <span className="tag ink">Recommended</span>
          <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
            Official ENS hackathon portal
          </span>
        </div>

        <p className="stitle" style={{ marginBottom: 10 }}>
          Get your name from ENS directly
        </p>
        <p style={{ margin: "0 0 20px", fontSize: 15.5, lineHeight: 1.6, maxWidth: "64ch" }}>
          ENS runs the deployment portal for this hackathon&rsquo;s Sepolia beta. It is the canonical place to
          register a name, so start there — a name registered with it works here unchanged.
        </p>

        <a className="btn btn-primary" href={ENS_PORTAL} target="_blank" rel="noreferrer">
          Open the ENS portal ↗
        </a>

        <hr className="sep" style={{ margin: "22px 0 16px" }} />

        <p className="hint" style={{ margin: 0, maxWidth: "64ch", color: "var(--ink)" }}>
          <b>Option 2 — register here instead.</b> The form below goes straight to the beta&rsquo;s{" "}
          <span className="mono">ETHRegistrar</span> and also mints the test token registration is priced in,
          which the portal does not hand out. Use it if the portal leaves you without a way to pay.
        </p>
      </div>

      <RegisterName initialLabel={label ?? ""} />
    </div>
  );
}
