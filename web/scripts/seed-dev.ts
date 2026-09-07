/**
 * Seeds the two prompts the already-minted analyst capsule points at, so the
 * real runner can be pointed at this backend instead of dev/prompt-server.ts.
 *
 *   cap_8f3d1a  the persona currently live on chain
 *   cap_7b21e9  the one to switch to, for the "change the record, change the
 *               agent" beat in the demo
 *
 * Bodies are copied from runner/dev/prompt-server.ts so behaviour is identical
 * across the swap and any difference in the runner is the backend's fault.
 *
 * This inserts with chosen refs, which the production path deliberately cannot
 * do — createPrompt() allocates a random ref, because in the real flow the
 * pointer is generated before the mint and never chosen by a caller. A fixture
 * needs fixed values, so it seals and inserts directly.
 *
 *   npm run seed:dev
 */
import { neon } from "@neondatabase/serverless";
import { aad, seal } from "../lib/capsule/crypto";
import { loadServerEnv } from "../lib/capsule/env";

const CAPSULE = "analyst.capsulefleet.eth";

const FIXTURES: Record<string, string> = {
  cap_8f3d1a: [
    "You are the analyst for a small ENS-native agent fleet.",
    "You watch ETH/USDC on Sepolia and report what changed and why it might matter.",
    "Answer in at most four sentences. Lead with the number, then the reading.",
    "If you do not have the data to answer, say so plainly rather than guessing.",
    "You know your own name and the records that configure you; you cannot change them.",
  ].join(" "),
  cap_7b21e9: [
    "You are the fleet's incident reporter.",
    "You describe what changed on chain in the last few minutes and who caused it.",
    "Be terse and factual. Name addresses, records and block numbers.",
    "Never speculate about intent; report the transaction and stop.",
  ].join(" "),
};

async function main() {
  const env = loadServerEnv();
  const sql = neon(env.databaseUrl);

  for (const [ref, body] of Object.entries(FIXTURES)) {
    const sealed = seal(env.masterKey, body, aad.prompt(ref, CAPSULE));
    // Re-seal on every run: the IV changes, so this also proves the envelope
    // round-trips under the master key currently in the environment.
    await sql`
      insert into capsule_prompt (ref, capsule_name, body_sealed)
      values (${ref}, ${CAPSULE}, ${sealed})
      on conflict (ref) do update set body_sealed = excluded.body_sealed
    `;
    console.log(`  seeded ${ref} → ${CAPSULE} (${body.length} chars)`);
  }
}

main().catch((error) => {
  console.error(`\nseed failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
