import { notFound } from "next/navigation";
import AgentDetail from "@/components/AgentDetail";
import FleetError from "@/components/FleetError";
import { loadCapsule } from "@/lib/capsule/fleet-server";

/* No generateStaticParams: the set of capsules is whatever the minter has
   emitted, which changes every time someone mints. Prerendering it would freeze
   the fleet at build time and 404 every name minted afterwards. */
export const dynamic = "force-dynamic";

export default async function CapsulePage({ params }: { params: Promise<{ label: string }> }) {
  const { label } = await params;
  const result = await loadCapsule(label);
  if (!result.ok) return <FleetError error={result.error} />;
  if (result.capsule === null) notFound();
  return <AgentDetail capsule={result.capsule} now={result.fleet.readAt} />;
}
