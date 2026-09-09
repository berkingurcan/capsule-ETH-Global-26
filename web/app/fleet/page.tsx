import FleetView from "@/components/FleetView";
import FleetError from "@/components/FleetError";
import { loadFleet } from "@/lib/capsule/fleet-server";

/* Rendered per request, not at build time. The RPC read has to happen where the
   secret is — the server — and its answer is only true for the block it was
   taken at, so caching it into a static page would put a stale heartbeat on a
   dashboard whose whole job is liveness. */
export const dynamic = "force-dynamic";

export default async function FleetPage() {
  const result = await loadFleet();
  if (!result.ok) return <FleetError error={result.error} />;
  return <FleetView fleet={result.fleet} />;
}
