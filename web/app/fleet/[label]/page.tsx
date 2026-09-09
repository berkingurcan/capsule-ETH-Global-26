import { notFound } from "next/navigation";
import AgentDetail from "@/components/AgentDetail";
import FleetError from "@/components/FleetError";
import { loadCapsule } from "@/lib/capsule/fleet-server";

/* No generateStaticParams: the set of capsules is whatever the minter has
   emitted, which changes every time someone mints. Prerendering it would freeze
   the fleet at build time and 404 every name minted afterwards. */
export const dynamic = "force-dynamic";

export default async function CapsulePage({
  params,
  searchParams,
}: {
  params: Promise<{ label: string }>;
  /* A label is only unique within a parent — `dev` exists under as many names as
     have connected one — so the route needs both halves to name a capsule. The
     parent stays in the query rather than the path because /fleet/dev under the
     deployment's own name is the common case and should keep its short URL. */
  searchParams: Promise<{ parent?: string }>;
}) {
  const [{ label }, { parent }] = await Promise.all([params, searchParams]);
  const result = await loadCapsule(label, parent);
  if (!result.ok) return <FleetError error={result.error} />;
  if (result.capsule === null) notFound();
  return <AgentDetail capsule={result.capsule} now={result.fleet.readAt} />;
}
