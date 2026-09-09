import LaunchFlow from "@/components/LaunchFlow";
import { loadServerEnv } from "@/lib/capsule/env";
import { loadFleet } from "@/lib/capsule/fleet-server";

/* A thin server shell around the client form, for two reasons.

   Which labels are already minted is a chain read, and the form must not offer
   a subname that `REGISTRY.register` would revert on. If the read fails the
   form still opens — a stale "taken" list makes a mint fail late, which is bad,
   but a launchpad that will not render at all is worse.

   The minter address is passed down rather than published as a
   `NEXT_PUBLIC_` variable. The browser genuinely needs it — it builds and signs
   the mint — but there is already one duplicated env var (the parent name) and
   each one is a place for the deployment to disagree with itself. A prop is
   read from the same `loadServerEnv()` every other server path uses, so it
   cannot drift. When it is missing the form renders and the mint step says so,
   rather than sending a transaction to `undefined`. */
export const dynamic = "force-dynamic";

export default async function LaunchPage() {
  const result = await loadFleet();
  const taken = result.ok ? result.fleet.capsules.map((capsule) => capsule.label) : [];

  let minter: string | null = null;
  try {
    minter = loadServerEnv().minterAddress;
  } catch {
    /* Reported on the mint step. The rest of the form is still usable. */
  }

  return <LaunchFlow taken={taken} minter={minter} />;
}
