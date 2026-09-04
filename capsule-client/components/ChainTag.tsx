import type { Chain } from "@/lib/mock";

/* Two chains, no bridge. Names live on ETH Sepolia; money settles on
   Base Sepolia. Every row that came off a subgraph says which one. */

export default function ChainTag({ chain }: { chain: Chain }) {
  return chain === "base" ? (
    <span className="tag bubble">Base</span>
  ) : (
    <span className="tag">Sepolia</span>
  );
}
