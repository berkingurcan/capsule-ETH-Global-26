import { notFound } from "next/navigation";
import AgentDetail from "@/components/AgentDetail";
import { AGENTS, findAgent } from "@/lib/mock";

export function generateStaticParams() {
  return AGENTS.map((a) => ({ label: a.label }));
}

export default async function AgentPage({ params }: { params: Promise<{ label: string }> }) {
  const { label } = await params;
  const agent = findAgent(label);
  if (!agent) notFound();
  return <AgentDetail agent={agent} />;
}
