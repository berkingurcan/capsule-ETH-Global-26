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

export default async function LaunchPage({
  searchParams,
}: {
  searchParams: Promise<{ parent?: string }>;
}) {
  // `?parent=` is where /connect sends someone who has just finished wiring their
  // own name, so the form opens on it rather than on the demo's. It is only a
  // default for the field — the browser re-reads the name off the chain before
  // anything can be signed, so a bogus one costs a failed check, not a bad mint.
  const { parent } = await searchParams;

  let defaultParent = "";
  let minter: string | null = null;
  try {
    const env = loadServerEnv();
    minter = env.minterAddress;
    defaultParent = env.defaultParentName;
  } catch {
    /* Reported on the mint step. The rest of the form is still usable. */
  }

  const requested = parent?.trim().toLowerCase();
  const opensOn = requested !== undefined && requested !== "" ? requested : defaultParent;

  // Only meaningful for the deployment's own parent — `loadFleet` reads one name's
  // capsules, and this render does not know which name the visitor will settle on.
  // The form greys out taken labels when it is showing that parent and stops when
  // it is not; either way the mint is gated on chain, twice.
  const result = await loadFleet();
  const taken =
    result.ok && opensOn === defaultParent
      ? result.fleet.capsules.map((capsule) => capsule.label)
      : [];

  return <LaunchFlow taken={taken} minter={minter} defaultParent={opensOn} />;
}
