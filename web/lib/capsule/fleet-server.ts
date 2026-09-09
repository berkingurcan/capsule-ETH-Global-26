/**
 * The fleet, loaded for a page render.
 *
 * Server-only: `SEPOLIA_RPC_URL` is not a public variable and the browser never
 * gets a chain client. That is not caution about the RPC key so much as about
 * where the read happens — the dashboard's claim is that it reads the same
 * records the runner does, and doing it server-side keeps one code path for
 * both instead of a second, browser-shaped one that can drift.
 *
 * Failure is returned, never thrown. An unreachable RPC or a missing variable
 * should render a page that says which one, because the alternative — a 500
 * during a demo — tells the viewer only that something is broken.
 */
import { createServerClient } from "./chain";
import { loadServerEnv } from "./env";
import { readFleet, type Capsule, type Fleet } from "./fleet";

export type FleetResult = { ok: true; fleet: Fleet } | { ok: false; error: string };

export async function loadFleet(): Promise<FleetResult> {
  try {
    const env = loadServerEnv();
    const client = createServerClient(env.rpcUrl);
    const fleet = await readFleet(client, {
      minter: env.minterAddress,
      parentName: env.parentName,
      fromBlock: env.minterBlock,
    });
    return { ok: true, fleet };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type CapsuleResult =
  | { ok: true; capsule: Capsule; fleet: Fleet }
  | { ok: false; error: string }
  | { ok: true; capsule: null; fleet: Fleet };

export async function loadCapsule(label: string): Promise<CapsuleResult> {
  const result = await loadFleet();
  if (!result.ok) return result;
  return {
    ok: true,
    capsule: result.fleet.capsules.find((capsule) => capsule.label === label) ?? null,
    fleet: result.fleet,
  };
}
