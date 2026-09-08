/* Which chain a row came off.

   There is only one now. Base Sepolia left with x402 on 2026-09-08, and this
   component stayed rather than being deleted from forty call sites: a row that
   says where it came from is still the right habit, and the tag becomes load
   bearing again the moment anything reads a second chain. */

export default function ChainTag() {
  return <span className="tag">Sepolia</span>;
}
