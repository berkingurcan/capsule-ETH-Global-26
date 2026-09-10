import FleetView from "@/components/FleetView";
import FleetError from "@/components/FleetError";
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
  return <FleetView fleet={result.fleet} />;
}
