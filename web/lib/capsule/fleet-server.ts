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
 *
 * ## Two readers, one type
 *
 * `SUBGRAPH_URL` set means the fleet is read from the index — one query, the
 * three-way join already done, and fields no log scan can produce. Unset, or
 * failing, means the chain reader in `fleet.ts`, which is slower and answers
 * from the head. Both return the same `Fleet`, and `Fleet.source` says which
 * one did, because the difference is a real one: an index lags.
 */
import { createServerClient } from "./chain";
import { loadServerEnv, optionalEnv } from "./env";
import { readFleet, type Capsule, type Fleet } from "./fleet";
import { readFleetFromSubgraph, SubgraphError } from "./fleet-graph";
import { encodeParent, readOwnerParents, type OwnedParent } from "./parent";

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

    const subgraphUrl = optionalEnv("SUBGRAPH_URL");
    if (subgraphUrl !== undefined) {
      try {
        // The head costs one call and is the only reason this path touches an
        // RPC at all. It buys `lagBlocks` — how far behind the index was when
        // it answered — which is the one thing a subgraph cannot tell you
        // about itself and the one thing a liveness dashboard has to say.
        const head = await client.getBlockNumber();
        const fleet = await readFleetFromSubgraph({
          url: subgraphUrl,
          minter: env.minterAddress,
          parentName: parent.name,
          head,
        });
        return { ok: true, fleet };
      } catch (error) {
        if (!(error instanceof SubgraphError)) throw error;
        // Fall through to the chain. A subgraph that is down, still syncing or
        // has hit an indexing error must not take the dashboard with it — the
        // chain reader is slower and always correct, and this is the one place
        // in the app where a silent fallback is right rather than lazy,
        // because `Fleet.source` makes it visible on the page.
        console.warn(`subgraph read failed, falling back to the chain: ${error.message}`);
      }
    }

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

export type OwnerParentsResult =
  | { ok: true; parents: OwnedParent[] }
  | { ok: false; error: string };

/**
 * The names one wallet has minted under or connected, for routing a bare /fleet.
 *
 * Server-side for the same reason `loadFleet` is: `SEPOLIA_RPC_URL` is not a
 * public variable, and the answer should come from the same client the fleet
 * itself is read with rather than from a second, browser-shaped path that can
 * drift.
 */
export async function loadOwnerParents(owner: string): Promise<OwnerParentsResult> {
  try {
    const env = loadServerEnv();
    const client = createServerClient(env.rpcUrl);
    const parents = await readOwnerParents(client, {
      minter: env.minterAddress,
      fromBlock: env.minterBlock,
      owner: owner as `0x${string}`,
    });
    return { ok: true, parents };
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
