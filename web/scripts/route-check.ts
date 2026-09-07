/**
 * Adversarial check on GET /api/prompt/:ref, over HTTP.
 *
 * store-check.ts proves the store; this proves the edge. It signs with the
 * REAL agent key for analyst.capsulefleet.eth and talks to a running server,
 * so the ENS resolve, the signature recovery and the scoped read all execute
 * for real. Nothing here is mocked.
 *
 *   BASE=http://localhost:3000 npm run check:route
 *
 * Needs AGENT_KEY, which lives in runner/.env — hence the two --env-file flags
 * in the npm script. The web app itself never holds an agent key.
 */
import { neon } from "@neondatabase/serverless";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { aad, seal } from "../lib/capsule/crypto";
import { loadServerEnv } from "../lib/capsule/env";
import {
  HEADER_NAME,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  promptFetchMessage,
  SIGNATURE_TTL_SECONDS,
} from "../lib/capsule/wire";

const BASE = (process.env.BASE ?? "http://localhost:3000").replace(/\/+$/, "");
const CAPSULE = "analyst.capsulefleet.eth";
const LIVE_REF = "cap_8f3d1a";
const OTHER_CAPSULE = "someone-else.capsulefleet.eth";
const OTHER_REF = "cap_routechk";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok    ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  }
};

type Attempt = {
  ref: string;
  name?: string;
  timestamp?: number;
  signature?: string;
  omit?: ("name" | "timestamp" | "signature")[];
};

async function call(a: Attempt): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  const omit = new Set(a.omit ?? []);
  if (!omit.has("name")) headers[HEADER_NAME] = a.name ?? CAPSULE;
  if (!omit.has("timestamp")) headers[HEADER_TIMESTAMP] = String(a.timestamp ?? 0);
  if (!omit.has("signature")) headers[HEADER_SIGNATURE] = a.signature ?? "0x00";

  const response = await fetch(`${BASE}/api/prompt/${encodeURIComponent(a.ref)}`, { headers });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* non-JSON is itself a finding, reported by the status check */
  }
  return { status: response.status, body };
}

async function main() {
  const env = loadServerEnv();
  const sql = neon(env.databaseUrl);

  const agentKey = process.env.AGENT_KEY;
  if (agentKey === undefined || agentKey === "") {
    console.error("AGENT_KEY is not set — this check signs as the real analyst agent");
    process.exit(1);
  }
  const agent = privateKeyToAccount(
    (agentKey.startsWith("0x") ? agentKey : `0x${agentKey}`) as `0x${string}`,
  );
  console.log(`  signing as ${agent.address}\n`);

  const sign = async (name: string, ref: string, timestamp: number) =>
    agent.signMessage({ message: promptFetchMessage(name, ref, timestamp) });

  const now = () => Math.floor(Date.now() / 1000);

  // A prompt belonging to a capsule the agent does not control. Seeded here so
  // the cross-capsule attempt hits a ref that genuinely exists — a 404 against
  // a ref that was never stored would prove nothing.
  await sql`
    insert into capsule_prompt (ref, capsule_name, body_sealed)
    values (${OTHER_REF}, ${OTHER_CAPSULE}, ${seal(env.masterKey, "someone else's instructions", aad.prompt(OTHER_REF, OTHER_CAPSULE))})
    on conflict (ref) do nothing
  `;

  // ---- happy path ---------------------------------------------------------
  {
    const t = now();
    const r = await call({ ref: LIVE_REF, timestamp: t, signature: await sign(CAPSULE, LIVE_REF, t) });
    const prompt = (r.body as { prompt?: string } | null)?.prompt;
    check("valid signature → 200", r.status === 200, `got ${r.status}`);
    check("returns the prompt body", typeof prompt === "string" && prompt.length > 100, `${typeof prompt}`);
  }

  // ---- missing headers ----------------------------------------------------
  for (const missing of ["name", "timestamp", "signature"] as const) {
    const t = now();
    const r = await call({
      ref: LIVE_REF,
      timestamp: t,
      signature: await sign(CAPSULE, LIVE_REF, t),
      omit: [missing],
    });
    check(`missing ${missing} → 400`, r.status === 400, `got ${r.status}`);
  }

  // ---- replay -------------------------------------------------------------
  {
    // A captured request from two minutes ago. The signature is genuine.
    const t = now() - SIGNATURE_TTL_SECONDS - 60;
    const r = await call({ ref: LIVE_REF, timestamp: t, signature: await sign(CAPSULE, LIVE_REF, t) });
    check("expired but genuine signature → 403", r.status === 403, `got ${r.status}`);
  }

  // ---- timestamp not covered by the signature -----------------------------
  {
    // Signed for t, presented as now. If the timestamp were outside the signed
    // message this would pass and the TTL would be decorative.
    const t = now() - SIGNATURE_TTL_SECONDS - 60;
    const r = await call({ ref: LIVE_REF, timestamp: now(), signature: await sign(CAPSULE, LIVE_REF, t) });
    check("timestamp is inside the signed message → 403", r.status === 403, `got ${r.status}`);
  }

  // ---- forged signatures --------------------------------------------------
  {
    const t = now();
    const r = await call({ ref: LIVE_REF, timestamp: t, signature: "0xdeadbeef" });
    check("garbage signature → 403", r.status === 403, `got ${r.status}`);
  }
  {
    const t = now();
    const stranger = privateKeyToAccount(generatePrivateKey());
    const r = await call({
      ref: LIVE_REF,
      timestamp: t,
      signature: await stranger.signMessage({ message: promptFetchMessage(CAPSULE, LIVE_REF, t) }),
    });
    check("well-formed signature from a stranger → 403", r.status === 403, `got ${r.status}`);
  }

  // ---- ref is inside the signed message -----------------------------------
  {
    // Signed for the live ref, presented against another. If the ref were not
    // covered, one captured signature would open every prompt on the name.
    const t = now();
    const r = await call({ ref: OTHER_REF, timestamp: t, signature: await sign(CAPSULE, LIVE_REF, t) });
    check("ref is inside the signed message → 403", r.status === 403, `got ${r.status}`);
  }

  // ---- THE ONE THAT MATTERS ----------------------------------------------
  // Valid agent, valid signature, correctly signed for a ref it read off the
  // chain — but the ref belongs to another capsule. This is the hole the dev
  // prompt server had.
  {
    const t = now();
    const r = await call({ ref: OTHER_REF, timestamp: t, signature: await sign(CAPSULE, OTHER_REF, t) });
    const leaked = (r.body as { prompt?: string } | null)?.prompt;
    check("cross-capsule fetch → 404", r.status === 404, `got ${r.status}`);
    check("nothing leaked", leaked === undefined, `leaked ${JSON.stringify(leaked)}`);
  }

  // ---- unknown ref --------------------------------------------------------
  {
    const t = now();
    const r = await call({ ref: "cap_000000", timestamp: t, signature: await sign(CAPSULE, "cap_000000", t) });
    check("unknown ref → 404", r.status === 404, `got ${r.status}`);
  }

  // ---- no caching ---------------------------------------------------------
  {
    const t = now();
    const response = await fetch(`${BASE}/api/prompt/${LIVE_REF}`, {
      headers: {
        [HEADER_NAME]: CAPSULE,
        [HEADER_TIMESTAMP]: String(t),
        [HEADER_SIGNATURE]: await sign(CAPSULE, LIVE_REF, t),
      },
    });
    const cc = response.headers.get("cache-control") ?? "";
    check("response is no-store", cc.includes("no-store"), `cache-control: ${cc}`);
  }

  await sql`delete from capsule_prompt where ref = ${OTHER_REF}`;

  console.log("");
  if (failures > 0) {
    console.error(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("prompt route holds under all of the above.\n");
}

main().catch((error) => {
  console.error(`\nroute check crashed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
