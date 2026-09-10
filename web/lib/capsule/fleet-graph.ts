/**
 * The fleet read path, served from the subgraph.
 *
 * Same answer as `fleet.ts`, same `Fleet` type, one HTTP request instead of
 * six RPC round trips plus one `eth_getBlock` per rendered block.
 *
 * ## What actually got easier, and it is not the round trips
 *
 * The chain reader's own header documents four bugs, and every one of them
 * was silent — an empty array, not an error. A `string indexed` topic hashed
 * twice and matching nothing. An `EACRolesChanged` shape that was a valid ABI
 * for a different event and returned zero logs forever. A `hasRoles` call with
 * two arguments where three were wanted, which `allowFailure: true` turned
 * into `status: "failure"` and the fallback turned into a fleet that rendered
 * every live capsule as recalled.
 *
 * All four are the same failure: the join between three event sources lives in
 * a page render, where nothing type-checks it against the chain and a wrong
 * answer looks exactly like a quiet one. Moving the join into the index does
 * not make those mistakes impossible, but it makes them *fail once, loudly, at
 * indexing time* rather than per render — and it puts them under
 * `graph test`, which is why `subgraph/tests/records.test.ts` exists.
 *
 * Three things this path can answer that the chain reader cannot:
 *
 *   - **Who signed a record write.** A log carries no sender. The chain reader
 *     infers `byAgent` from the key, which is a guess that happens to be right;
 *     the index stores `transaction.from`, which is the answer.
 *   - **How long a capsule had been quiet when its role was pulled.** Two
 *     contracts, two cadences, no shared event — the chain reader would have to
 *     fetch and align both series. `RoleChange.secondsSinceLastBeat` is a field.
 *   - **Beat intervals without a block-timestamp fetch each.** `blockTimes()`
 *     costs one `eth_getBlock` per distinct block on every render.
 *
 * ## Why this is not simply better
 *
 * An index lags. `_meta.block` is how far it had got when it answered, and it
 * is carried into `Fleet.lagBlocks` rather than smoothed over, because the
 * dashboard's subject is liveness and a heartbeat that has landed on chain but
 * not yet in the index must not read as silence. `fleet-server.ts` decides
 * which reader runs; both remain correct.
 */
import { namehash, type Address, type Hex } from "viem";
import { RECORD_KEYS, type RecordKeyName } from "./records";
import type { OwnedParent } from "./parent";
import {
  buildEvents,
  deriveStatus,
  median,
  type Capsule,
  type ChainWrite,
  type Fleet,
  type RoleChangeRow,
} from "./fleet";

export class SubgraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubgraphError";
  }
}

/**
 * How many rows to pull per capsule.
 *
 * The dashboard renders eight activity rows and one sparkline, so these are
 * generous rather than complete — and they are bounded on purpose, because a
 * capsule beating every 60 seconds accumulates a thousand heartbeats a day and
 * nothing on the page reads the thousandth. `beatCount` on the capsule is the
 * indexer's own counter, so the total stays exact however few rows come back.
 */
const WRITES_PER_CAPSULE = 250;
const BEATS_PER_CAPSULE = 250;
const ROLE_CHANGES_PER_CAPSULE = 50;
const CAPSULES_PER_PARENT = 500;

/**
 * One query, and the nesting is the point.
 *
 * `capsules { writes heartbeats roleChanges }` is three joins the chain reader
 * performs by hand across three `getContractEvents` calls and a `Map` keyed by
 * node. Here it is the shape of the request.
 *
 * `_meta` is not optional decoration: without it there is no way to say how
 * stale this answer is, and an answer with no staleness attached is the one
 * thing a liveness dashboard must not print.
 *
 * Exported so `scripts/check-subgraph.ts` can walk it against
 * `subgraph/schema.graphql`. That guard matters more than it looks: a renamed
 * entity field makes this query fail, `loadFleet` catches the `SubgraphError`
 * and falls back to the chain reader, and the dashboard keeps working — which
 * means nothing about the subgraph would ever be noticed to have broken.
 */
export const FLEET_QUERY = `
query Fleet($parent: String!, $capsules: Int!, $writes: Int!, $beats: Int!, $roles: Int!) {
  _meta {
    block { number timestamp }
    hasIndexingErrors
  }
  parents(where: { name: $parent }, first: 1) {
    id
    name
    node
    resolver
    capsules(first: $capsules, orderBy: mintedAtBlock, orderDirection: asc) {
      id
      label
      name
      tokenId
      owner
      agent
      addr
      expiry
      resolver
      mintedAt
      mintedAtBlock
      mintTx
      nodeClass
      schemaUri
      context
      endpointWeb
      endpointCapsule
      model
      runtime
      prompt
      heartbeat
      registrationKey
      registrationValue
      authorized
      recalledAt
      recalledAtBlock
      recalledTx
      beatCount
      lastBeatAt
      writes(first: $writes, orderBy: block, orderDirection: desc) {
        key
        value
        writer
        byAgent
        isHeartbeat
        block
        timestamp
        tx
      }
      heartbeats(first: $beats, orderBy: timestamp, orderDirection: desc) {
        sequence
        value
        interval
        block
        timestamp
        tx
      }
      roleChanges(
        first: $roles
        orderBy: block
        orderDirection: desc
        where: { resourceKind: "agent-heartbeat" }
      ) {
        account
        oldRoleBitmap
        newRoleBitmap
        block
        timestamp
        tx
      }
    }
  }
}`;

type GraphWrite = {
  key: string;
  value: string;
  writer: string;
  byAgent: boolean;
  isHeartbeat: boolean;
  block: string;
  timestamp: string;
  tx: string;
};

type GraphBeat = {
  sequence: string;
  value: string;
  interval: string | null;
  block: string;
  timestamp: string;
  tx: string;
};

type GraphRoleChange = {
  account: string;
  oldRoleBitmap: string;
  newRoleBitmap: string;
  block: string;
  timestamp: string;
  tx: string;
};

type GraphCapsule = {
  id: string;
  label: string;
  name: string;
  tokenId: string;
  owner: string;
  agent: string;
  addr: string;
  expiry: string;
  resolver: string;
  mintedAt: string;
  mintedAtBlock: string;
  mintTx: string;
  nodeClass: string;
  schemaUri: string;
  context: string;
  endpointWeb: string;
  endpointCapsule: string;
  model: string;
  runtime: string;
  prompt: string;
  heartbeat: string;
  registrationKey: string;
  registrationValue: string;
  authorized: boolean;
  recalledAt: string | null;
  recalledAtBlock: string | null;
  recalledTx: string | null;
  beatCount: number;
  lastBeatAt: string | null;
  writes: GraphWrite[];
  heartbeats: GraphBeat[];
  roleChanges: GraphRoleChange[];
};

export type SubgraphFleetConfig = {
  url: string;
  minter: Address;
  parentName: string;
  /**
   * The chain head, if the caller already knows it.
   *
   * Used only to report how far behind the index is. It is optional because
   * fetching it would put an RPC round trip back into a path whose point is
   * not making one — `fleet-server.ts` passes the head when it happens to have
   * it, and `lagBlocks` is null otherwise.
   */
  head?: bigint;
  /** Milliseconds before the query is abandoned. A slow index must not hang a render. */
  timeoutMs?: number;
};

/**
 * One GraphQL request, with the failures that matter turned into throws.
 *
 * Extracted because two callers need it and because the subtle part is worth
 * writing once: **GraphQL reports failures inside a 200**. Treating a response
 * as successful because the status said so is how a dashboard renders an empty
 * fleet and calls it a fleet with nothing in it.
 */
async function query<T>(
  url: string,
  document: string,
  variables: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let payload: { data?: T; errors?: { message: string }[] };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: document, variables }),
      signal: controller.signal,
      // The index moves; a cached fleet is a stale heartbeat.
      cache: "no-store",
    });
    if (!response.ok) {
      throw new SubgraphError(`the subgraph answered ${response.status} ${response.statusText}`);
    }
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    if (error instanceof SubgraphError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new SubgraphError("the subgraph did not answer in time");
    }
    throw new SubgraphError(error instanceof Error ? error.message : "the subgraph query failed");
  } finally {
    clearTimeout(timer);
  }

  if (payload.errors !== undefined && payload.errors.length > 0) {
    throw new SubgraphError(payload.errors.map((e) => e.message).join("; "));
  }
  if (payload.data === undefined) throw new SubgraphError("the subgraph returned no data");
  return payload.data;
}

export async function readFleetFromSubgraph(config: SubgraphFleetConfig): Promise<Fleet> {
  const { url, minter, parentName } = config;

  const data = await query<{
    _meta: { block: { number: number; timestamp: number | null }; hasIndexingErrors: boolean } | null;
    parents: { id: string; name: string; node: string; resolver: string; capsules: GraphCapsule[] }[];
  }>(
    url,
    FLEET_QUERY,
    {
      parent: parentName,
      capsules: CAPSULES_PER_PARENT,
      writes: WRITES_PER_CAPSULE,
      beats: BEATS_PER_CAPSULE,
      roles: ROLE_CHANGES_PER_CAPSULE,
    },
    config.timeoutMs ?? 10_000,
  );

  const meta = data._meta;
  if (meta === null) throw new SubgraphError("the subgraph has not indexed any blocks yet");
  if (meta.hasIndexingErrors) {
    // A subgraph that failed mid-chain keeps serving whatever it had reached,
    // which is the worst possible answer here: a fleet frozen at the block a
    // handler threw on, presented as current.
    throw new SubgraphError(
      `the subgraph reports indexing errors and stopped at block ${meta.block.number} — its answer is not current`,
    );
  }

  const indexedBlock = BigInt(meta.block.number);
  const readAt = Math.floor(Date.now() / 1000);

  const parent = data.parents[0];
  if (parent === undefined) {
    // A name nobody has connected. Not an error — it is what `/fleet?parent=`
    // for a stranger's name correctly looks like.
    return {
      parent: parentName,
      minter,
      capsules: [],
      events: [],
      block: indexedBlock,
      readAt,
      source: "subgraph",
      lagBlocks: lagOf(config.head, indexedBlock),
    };
  }

  const capsules = parent.capsules.map((row) => toCapsule(row, parentName, readAt));
  const roleChanges: RoleChangeRow[] = [];
  for (const row of parent.capsules) {
    for (const change of row.roleChanges) {
      roleChanges.push({
        name: row.name,
        account: change.account as Address,
        oldRoleBitmap: BigInt(change.oldRoleBitmap),
        newRoleBitmap: BigInt(change.newRoleBitmap),
        block: BigInt(change.block),
        at: Number(change.timestamp),
        tx: change.tx as Hex,
      });
    }
  }

  return {
    parent: parentName,
    minter,
    capsules,
    events: buildEvents(capsules, roleChanges),
    block: indexedBlock,
    readAt,
    source: "subgraph",
    lagBlocks: lagOf(config.head, indexedBlock),
  };
}

function lagOf(head: bigint | undefined, indexed: bigint): number | null {
  if (head === undefined) return null;
  return head > indexed ? Number(head - indexed) : 0;
}

function toCapsule(row: GraphCapsule, parentName: string, now: number): Capsule {
  const writes: ChainWrite[] = row.writes.map((write) => ({
    key: write.key,
    value: write.value,
    block: BigInt(write.block),
    tx: write.tx as Hex,
    at: Number(write.timestamp),
    // The index knows who signed; the chain reader could only infer it from
    // the key. Kept as the same field so `buildEvents` and `AgentCard` do not
    // have to know which reader produced the row.
    byAgent: write.byAgent,
  }));

  // Oldest first, to match the chain reader — `intervals[0]` is the gap after
  // the first beat, and a sparkline drawn backwards is not obviously wrong.
  const beats = [...row.heartbeats].reverse();
  const intervals = beats
    .map((beat) => (beat.interval === null ? null : Number(beat.interval)))
    .filter((interval): interval is number => interval !== null);

  const last = beats.length > 0 ? beats[beats.length - 1] : null;
  const lastBeat: ChainWrite | null =
    last === null
      ? null
      : {
          key: RECORD_KEYS.heartbeat,
          value: last.value,
          block: BigInt(last.block),
          tx: last.tx as Hex,
          at: Number(last.timestamp),
          byAgent: true,
        };

  // From `lastBeatAt` rather than from the fetched rows: the row cap above
  // means the newest beat is always present, but reading the capsule's own
  // field keeps the two independent of each other.
  const lastBeatAt = row.lastBeatAt === null ? null : Number(row.lastBeatAt);
  const quietFor = lastBeatAt === null ? null : Math.max(0, now - lastBeatAt);
  const cadence = median(intervals);

  const records = {
    class: row.nodeClass,
    schema: row.schemaUri,
    context: row.context,
    endpointWeb: row.endpointWeb,
    endpointCapsule: row.endpointCapsule,
    model: row.model,
    runtime: row.runtime,
    prompt: row.prompt,
    heartbeat: row.heartbeat,
  } satisfies Record<RecordKeyName, string>;

  return {
    label: row.label,
    parent: parentName,
    name: row.name,
    node: row.id as Hex,
    tokenId: BigInt(row.tokenId),
    owner: row.owner as Address,
    agent: row.agent as Address,
    expiry: Number(row.expiry),
    mintedAt: {
      block: BigInt(row.mintedAtBlock),
      tx: row.mintTx as Hex,
      at: Number(row.mintedAt),
    },
    resolver: row.resolver as Address,
    addr: row.addr as Address,
    records,
    registrationKey: row.registrationKey,
    registrationValue: row.registrationValue,
    // The chain reader asks `hasRoles` at the head. The index has watched every
    // `EACRolesChanged` on this resource since the mint, so this is the same
    // question answered from the history rather than from a call — and it is
    // the one field where the two readers could disagree, if the index lags a
    // revocation. `lagBlocks` is on the `Fleet` for exactly that reason.
    authorized: row.authorized,
    status: deriveStatus(row.authorized, quietFor, cadence),
    beatCount: row.beatCount,
    lastBeat,
    intervals,
    cadence,
    quietFor,
    recalledAt:
      !row.authorized && row.recalledAt !== null && row.recalledAtBlock !== null
        ? {
            block: BigInt(row.recalledAtBlock),
            tx: (row.recalledTx ?? "0x") as Hex,
            at: Number(row.recalledAt),
          }
        : null,
    writes,
  };
}

/** One capsule, by label. The query is per parent, so this reads the fleet. */
export async function readCapsuleFromSubgraph(
  label: string,
  config: SubgraphFleetConfig,
): Promise<Capsule | null> {
  const fleet = await readFleetFromSubgraph(config);
  return fleet.capsules.find((capsule) => capsule.label === label) ?? null;
}


////////////////////////////////////////////////////////////////////////////
// Whose fleet is this?
////////////////////////////////////////////////////////////////////////////

/**
 * The names one wallet has capsules under, or connected itself.
 *
 * This is what routes a bare `/fleet` to the fleet the visitor actually has,
 * and it is the same question the analyst has to answer before it can scope a
 * question to "my agents". Both go through here so they cannot disagree about
 * whose fleet is whose.
 *
 * Two signals, because there are two ways to have a fleet and neither implies
 * the other. A wallet that called `connectParent` owns the name whether or not
 * it has minted anything yet; a wallet that minted under somebody else's open
 * parent has agents under a name it does not own. `readOwnerParents` in
 * `parent.ts` gets the same pair off `ParentConnected` and `CapsuleMinted`
 * logs — this asks the index instead, which turns a full log scan plus a
 * `parentOf` multicall into one request.
 */
const OWNER_PARENTS_QUERY = `
query OwnerParents($owner: Bytes!) {
  connected: parents(where: { connectedBy: $owner, connected: true }, first: 50) {
    name
    node
    id
    open
    capsuleCount
  }
  minted: capsules(where: { owner: $owner }, first: 500) {
    label
    parent { name node id open connected }
  }
}`;

type GraphOwnerParent = {
  name: string;
  node: string;
  id: string;
  open: boolean;
  capsuleCount: number;
};

type GraphOwnedCapsule = {
  label: string;
  parent: { name: string; node: string; id: string; open: boolean; connected: boolean };
};

export async function readOwnerParentsFromSubgraph(
  url: string,
  owner: Address,
  timeoutMs = 10_000,
): Promise<OwnedParent[]> {
  const payload = await query<{
    connected: GraphOwnerParent[];
    minted: GraphOwnedCapsule[];
  }>(url, OWNER_PARENTS_QUERY, { owner: owner.toLowerCase() }, timeoutMs);

  const found = new Map<string, OwnedParent>();

  for (const parent of payload.connected) {
    found.set(parent.name, {
      name: parent.name,
      node: parent.node as Hex,
      registry: parent.id as Address,
      open: parent.open,
      minted: 0,
      connectedByOwner: true,
    });
  }

  // Counted by distinct label, so a name re-minted after expiry is one agent
  // and not two — the same rule the chain reader applies.
  const labels = new Map<string, Set<string>>();
  for (const capsule of payload.minted) {
    const parent = capsule.parent;
    if (!parent.connected) continue;
    const seen = labels.get(parent.name) ?? new Set<string>();
    seen.add(capsule.label);
    labels.set(parent.name, seen);
    if (!found.has(parent.name)) {
      found.set(parent.name, {
        name: parent.name,
        node: parent.node as Hex,
        registry: parent.id as Address,
        open: parent.open,
        minted: 0,
        connectedByOwner: false,
      });
    }
  }
  for (const [name, seen] of labels) {
    const parent = found.get(name);
    if (parent !== undefined) parent.minted = seen.size;
  }

  // The index stores the name the minter published in DNS wire format; this
  // confirms it still hashes to the node it is filed under. A name that does
  // not is dropped rather than shown, for the same reason `parent.ts` verifies
  // its own decode: a wrong name here is a dashboard confidently showing the
  // wrong fleet.
  return [...found.values()].filter(
    (parent) => parent.name !== "" && namehash(parent.name).toLowerCase() === parent.node.toLowerCase(),
  );
}
