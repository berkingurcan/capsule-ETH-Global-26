import FleetView from "@/components/FleetView";
import FleetError from "@/components/FleetError";
import FleetRouterMount from "@/components/FleetRouterMount";
import { loadFleet } from "@/lib/capsule/fleet-server";

/* Rendered per request, not at build time. The RPC read has to happen where the
   secret is — the server — and its answer is only true for the block it was
   taken at, so caching it into a static page would put a stale heartbeat on a
   dashboard whose whole job is liveness. */
export const dynamic = "force-dynamic";

export default async function FleetPage({
  searchParams,
}: {
  searchParams: Promise<{ parent?: string }>;
}) {
  /* Whose fleet. One minter now serves every connected name, so "the fleet" is
     no longer a thing that exists — there is a fleet per parent, and this is how
     you say which. Absent, it is the deployment's own.

     An unusable name is reported rather than swapped for the default: a
     dashboard showing capsulefleet.eth's agents to someone who asked for
     berkin.eth's is worse than one that says the name is wrong, because the
     first looks like an answer. */
  const { parent } = await searchParams;
  const result = await loadFleet(parent);
  if (!result.ok) return <FleetError error={result.error} />;

  /* An unqualified /fleet is a question the server cannot answer: the parent
     worth showing is the visitor's, and the visitor is a wallet that exists only
     in their browser. So the default fleet renders — immediately, and correctly
     for a stranger — and `FleetRouter` upgrades it to their own once the address
     is known. Only when the parent was left off: someone who asked for a
     specific name gets that name and nothing clever on top. */
  const asked = parent?.trim() ?? "";

  return (
    <>
      {asked === "" && <FleetRouterMount showing={result.fleet.parent} />}
      <FleetView fleet={result.fleet} />
    </>
  );
}
