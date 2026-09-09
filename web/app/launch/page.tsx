import LaunchFlow from "@/components/LaunchFlow";
import { loadFleet } from "@/lib/capsule/fleet-server";

/* A thin server shell around the client form, for one reason: which labels are
   already minted is a chain read, and the form must not offer a subname that
   `REGISTRY.register` would revert on. If the read fails the form still opens —
   a stale "taken" list makes a mint fail late, which is bad, but a launchpad
   that will not render at all is worse. */
export const dynamic = "force-dynamic";

export default async function LaunchPage() {
  const result = await loadFleet();
  const taken = result.ok ? result.fleet.capsules.map((capsule) => capsule.label) : [];
  return <LaunchFlow taken={taken} />;
}
