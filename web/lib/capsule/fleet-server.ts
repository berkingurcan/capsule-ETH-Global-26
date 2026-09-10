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
import { encodeParent } from "./parent";

export type FleetResult = { ok: true; fleet: Fleet } | { ok: false; error: string };

/**
 * @param parentName Which name's fleet to read. Defaults to `CAPSULE_PARENT_NAME`,
 *   which is what an unqualified `/fleet` shows. A name that fails validation is
 *   returned as an error rather than silently falling back to the default: a
 *   dashboard that answers a question you did not ask, under a heading naming the
 *   name you did, is worse than one that says the name is unusable.
 */
export async function loadFleet(parentName?: string): Promise<FleetResult> {
  try {
    const env = loadServerEnv();
    const parent = encodeParent(parentName ?? env.defaultParentName);
    const client = createServerClient(env.rpcUrl);
    const fleet = await readFleet(client, {
      minter: env.minterAddress,
      parentName: parent.name,
      parentNode: parent.node,
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

export async function loadCapsule(label: string, parentName?: string): Promise<CapsuleResult> {
  const result = await loadFleet(parentName);
  if (!result.ok) return result;
  return {
    ok: true,
    capsule: result.fleet.capsules.find((capsule) => capsule.label === label) ?? null,
    fleet: result.fleet,
  };
}
