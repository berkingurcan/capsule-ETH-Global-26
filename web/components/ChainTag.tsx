/* One chain. Names, roles and heartbeats all live on ETH Sepolia.

   This used to branch on a `Chain` union because money settled on Base
   Sepolia over x402. That was cut on 2026-09-08 (DECISIONS.md), and with
   it the second chain — so the tag is now a constant, kept because every
   row still says which chain it came off. */

export default function ChainTag() {
  return <span className="tag">Sepolia</span>;
}
