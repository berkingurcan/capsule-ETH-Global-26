/**
 * The fleet read path: what the dashboard knows, and how it knows it.
 *
 * Every value on /fleet comes from one of three places on ETH Sepolia, and
 * nothing comes from anywhere else:
 *
 *   1. `CapsuleMinter.CapsuleMinted`  — which names exist, and who owns them.
 *   2. `PermissionedResolver.text()`  — what each name currently says.
 *   3. `PermissionedResolver.hasRoles(...)` — whether the agent may still write.
 *
 * The third is the one that matters. A capsule is "alive" because a role on a
 * resource says so, not because a machine is up, and this module never asks a
 * machine. That is the whole claim of the project, so the dashboard has to make
 * it the same way the runner does.
 *
 * Two things here were wrong in an obvious-looking first draft and are worth
 * naming, because both fail *silently* — an empty array, not an error:
 *
 *   - `TextChanged.indexedKey` is `string indexed`, so the topic is the hash.
 *     viem hashes the value you pass, so you pass the plain string. Passing a
 *     pre-hashed value hashes it twice and matches nothing.
 *   - `EACRolesChanged` is `(resource, account, oldRoleBitmap, newRoleBitmap)`.
 *     A guessed `(resource, roleBitmap, account, granted)` shape is a valid ABI
 *     that computes a different topic0 and quietly returns zero logs forever.
 *
 * Both were caught by checking counts against a name known to have history.
 * Neither would have failed a build or a type check.
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  ROLE_SET_TEXT,
  UNIVERSAL_RESOLVER_V2,
  minterAbi,
  resolverAbi,
  textResourceOf,
  universalResolverAbi,
} from "./chain";
import { RECORD_KEYS, REGISTRATION_VALUE, parseHeartbeatSequence, type RecordKeyName } from "./records";
import { encodeName } from "./resolve";

/** The resolver events we read. Signatures verified against the deployed source. */
export const resolverEventsAbi = parseAbi([
  "event TextChanged(bytes32 indexed node, string indexed indexedKey, string key, string value)",
  "event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)",
]);

/**
 * Re-exported from `chain.ts`, where it sits next to the write path that needs
 * the same derivation. `scripts/check-fleet.ts` imports it from here.
 */
export { textResourceOf };

/**
 * What a capsule is doing, as far as the chain can actually tell.
 *
 * Deliberately four states, not the mock's three. "Booting" was a fiction: a
 * name that has been minted and never run is indistinguishable on chain from
 * one whose machine died before its first beat, and calling either "booting"
 * asserts something we cannot see. `silent` is the honest version of that.
 */
export type CapsuleStatus = "beating" | "silent" | "never-booted" | "recalled";

export type ChainWrite = {
  key: string;
  value: string;
  block: bigint;
  tx: Hex;
  at: number | null;
  /** The agent may only ever write the heartbeat; everything else is the owner. */
  byAgent: boolean;
};

export type Capsule = {
  label: string;
  parent: string;
  name: string;
  node: Hex;
  tokenId: bigint;
  owner: Address;
  agent: Address;
  expiry: number;
  mintedAt: { block: bigint; tx: Hex; at: number | null };

  resolver: Address;
  addr: Address;
  /** The nine keys `mint()` writes, by their property name in RECORD_KEYS. */
  records: Record<RecordKeyName, string>;
  registrationKey: string;
  registrationValue: string;

  /** `hasRoles(textResourceOf(node, "agent-heartbeat"), ROLE_SET_TEXT, agent)`. */
  authorized: boolean;
  status: CapsuleStatus;

  beatCount: number;
  lastBeat: ChainWrite | null;
  /** Seconds between consecutive beats, oldest first. */
  intervals: number[];
  /** The median of `intervals`, or null when there are fewer than two beats. */
  cadence: number | null;
  /** Seconds since the last beat landed, or null if it never beat. */
  quietFor: number | null;
  /** The revocation that recalled this capsule, if it is recalled. */
  recalledAt: { block: bigint; tx: Hex; at: number | null } | null;

  /** Every record write on this name, newest first. The real runner log. */
  writes: ChainWrite[];
};

export type FleetEvent = {
  id: string;
  kind: "minted" | "recalled" | "granted" | "record" | "heartbeat";
  name: string;
  text: string;
  detail?: string;
  block: bigint;
  at: number | null;
  tx: Hex;
};

export type Fleet = {
  parent: string;
  minter: Address;
  capsules: Capsule[];
  events: FleetEvent[];
  /** Block the read was taken at, so the UI can say how fresh it is. */
  block: bigint;
  readAt: number;
};

export type FleetConfig = {
  minter: Address;
  parentName: string;
  /**
   * Namehash of `parentName`, passed to `getContractEvents` as a topic filter.
   *
   * This is what keeps one name's capsules out of another name's dashboard. The
   * minter serves every connected parent from one address and one log stream, so
   * without it `/fleet?parent=berkin.eth` would list `trader.capsulefleet.eth`
   * alongside `dev.berkin.eth` — and then read records for a name it built by
   * gluing the wrong parent onto a label, which resolves to nothing and renders
   * as a fleet of empty capsules rather than as an error.
   *
   * Taken as an argument rather than derived from `parentName` here so it is
   * derived once, by the caller that already validated the name.
   */
  parentNode: Hex;
  /** The minter's deploy block. Scanning from 0 is not an option on a public RPC. */
  fromBlock: bigint;
};

const RECORD_ENTRIES = Object.entries(RECORD_KEYS) as [RecordKeyName, string][];

function emptyRecords(): Record<RecordKeyName, string> {
  return Object.fromEntries(RECORD_ENTRIES.map(([prop]) => [prop, ""])) as Record<RecordKeyName, string>;
}

/**
 * One `hasRoles` multicall entry.
 *
 * A function rather than an inline object literal so that the argument count is
 * checked by something. viem type-checks `args` against the ABI only when the
 * `contracts` array is a tuple literal; build it with `.map()` — which any
 * fleet-sized query must — and the element type widens until a two-argument call
 * to a three-argument function compiles clean. That is exactly how every capsule
 * came to read as recalled, so the shape of the call now lives in one signature
 * that cannot be called wrong.
 */
function hasRolesCall(resolver: Address, resource: bigint, account: Address) {
  return {
    address: resolver,
    abi: resolverAbi,
    functionName: "hasRoles",
    args: [resource, ROLE_SET_TEXT, account],
  } as const;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * When to stop calling a capsule "beating".
 *
 * There is no on-chain cadence to read: `HEARTBEAT_SECONDS` lives in the
 * runner's environment, and the demo runs it at 60s against a documented
 * default of 28800. So the threshold is derived from the name's *own* observed
 * intervals — three missed beats — rather than from a constant that would be
 * wrong for every capsule but one.
 *
 * With fewer than two beats there is nothing to derive from, so we fall back to
 * ten minutes and the UI says the cadence is unknown rather than implying it.
 */
const UNKNOWN_CADENCE_GRACE = 600;

function deriveStatus(authorized: boolean, quietFor: number | null, cadence: number | null): CapsuleStatus {
  if (!authorized) return "recalled";
  if (quietFor === null) return "never-booted";
  const limit = cadence === null ? UNKNOWN_CADENCE_GRACE : Math.max(cadence * 3, 90);
  return quietFor <= limit ? "beating" : "silent";
}

/**
 * Block timestamps for a set of blocks, fetched once each.
 *
 * Events carry no time, and the feed is useless without one. The set is small
 * — record writes on a demo fleet — but it is unbounded in principle, so the
 * caller passes only the blocks it will actually render.
 */
async function blockTimes(client: PublicClient, blocks: Iterable<bigint>): Promise<Map<bigint, number>> {
  const unique = [...new Set(blocks)];
  const times = new Map<bigint, number>();
  const results = await Promise.all(
    unique.map(async (blockNumber) => {
      try {
        const block = await client.getBlock({ blockNumber });
        return [blockNumber, Number(block.timestamp)] as const;
      } catch {
        // A pruned or unavailable block costs a timestamp, not the page.
        return [blockNumber, null] as const;
      }
    }),
  );
  for (const [blockNumber, timestamp] of results) {
    if (timestamp !== null) times.set(blockNumber, timestamp);
  }
  return times;
}

/**
 * Read every text record for a set of names in one multicall.
 *
 * `allowFailure: true` on purpose, and unlike `readIdentity` in resolve.ts. That
 * function authorises a request and must not proceed on a partial answer; this
 * one draws a dashboard, where one unresolvable key should leave one cell empty
 * rather than blank the fleet.
 */
async function readAllRecords(
  client: PublicClient,
  names: { name: string; node: Hex; dnsName: Hex }[],
  extraKeys: Map<string, string>,
): Promise<Map<string, { records: Record<RecordKeyName, string>; registration: string; addr: Address; resolver: Address }>> {
  type Slot = { name: string; kind: "addr" | "text" | "registration"; prop?: RecordKeyName };
  type ResolveCall = {
    address: Address;
    abi: typeof universalResolverAbi;
    functionName: "resolve";
    args: readonly [Hex, Hex];
  };
  const slots: Slot[] = [];
  const contracts: ResolveCall[] = [];

  for (const { name, node, dnsName } of names) {
    slots.push({ name, kind: "addr" });
    contracts.push({
      address: UNIVERSAL_RESOLVER_V2,
      abi: universalResolverAbi,
      functionName: "resolve",
      args: [dnsName, encodeFunctionData({ abi: resolverAbi, functionName: "addr", args: [node] })],
    });

    for (const [prop, key] of RECORD_ENTRIES) {
      slots.push({ name, kind: "text", prop });
      contracts.push({
        address: UNIVERSAL_RESOLVER_V2,
        abi: universalResolverAbi,
        functionName: "resolve",
        args: [dnsName, encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [node, key] })],
      });
    }

    const registrationKey = extraKeys.get(name);
    if (registrationKey !== undefined) {
      slots.push({ name, kind: "registration" });
      contracts.push({
        address: UNIVERSAL_RESOLVER_V2,
        abi: universalResolverAbi,
        functionName: "resolve",
        args: [dnsName, encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [node, registrationKey] })],
      });
    }
  }

  const results = (await client.multicall({
    contracts,
    allowFailure: true,
  })) as { status: "success" | "failure"; result?: unknown }[];

  const out = new Map<string, { records: Record<RecordKeyName, string>; registration: string; addr: Address; resolver: Address }>();
  for (const { name } of names) {
    out.set(name, { records: emptyRecords(), registration: "", addr: zeroAddress, resolver: zeroAddress });
  }

  results.forEach((result, index) => {
    const slot = slots[index];
    const entry = out.get(slot.name);
    if (entry === undefined || result.status !== "success") return;

    const [data, resolver] = result.result as readonly [Hex, Address];
    if (entry.resolver === zeroAddress) entry.resolver = resolver;
    if (data === "0x") return;

    if (slot.kind === "addr") {
      entry.addr = decodeFunctionResult({ abi: resolverAbi, functionName: "addr", data });
      return;
    }
    const value = decodeFunctionResult({ abi: resolverAbi, functionName: "text", data });
    if (slot.kind === "registration") entry.registration = value;
    else if (slot.prop !== undefined) entry.records[slot.prop] = value;
  });

  return out;
}

/**
 * The whole fleet, in roughly six RPC round trips plus one per rendered block.
 *
 * Order matters: the mint events name the capsules, and everything after is
 * keyed off them. A name that was registered by hand rather than through the
 * minter does not appear here — which is correct. `agent-registration` is the
 * claim that a name belongs to an agent in *this* registry, and a name the
 * minter never touched has no such claim to read.
 */
export async function readFleet(client: PublicClient, config: FleetConfig): Promise<Fleet> {
  const { minter, parentName, parentNode, fromBlock } = config;

  const [head, minted, registryInterop] = await Promise.all([
    client.getBlockNumber(),
    client.getContractEvents({
      address: minter,
      abi: minterAbi,
      eventName: "CapsuleMinted",
      // `parentNode` is the first indexed field, so this is a topic filter the RPC
      // applies — not a post-filter here. One name's dashboard therefore costs the
      // same one call whether the minter serves one parent or a hundred.
      args: { parentNode },
      fromBlock,
      toBlock: "latest",
    }),
    client.readContract({ address: minter, abi: minterAbi, functionName: "REGISTRY_INTEROP_ADDRESS" }),
  ]);

  if (minted.length === 0) {
    return { parent: parentName, minter, capsules: [], events: [], block: head, readAt: Math.floor(Date.now() / 1000) };
  }

  // Newest mint per label wins. A label can only be minted once while it is
  // registered, but it can be re-minted after expiry, and the stale event would
  // otherwise resurrect the previous owner.
  const byLabel = new Map<string, (typeof minted)[number]>();
  for (const log of minted) {
    const label = log.args.label as string;
    const previous = byLabel.get(label);
    if (previous === undefined || (log.blockNumber ?? 0n) >= (previous.blockNumber ?? 0n)) {
      byLabel.set(label, log);
    }
  }
  const mints = [...byLabel.values()].sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)));

  const names = mints.map((log) => {
    const label = log.args.label as string;
    return { label, ...encodeName(`${label}.${parentName}`), node: log.args.node as Hex };
  });
  const nodes = names.map((n) => n.node);

  const registrationKeys = new Map<string, string>();
  mints.forEach((log, index) => {
    registrationKeys.set(names[index].name, `agent-registration[${registryInterop}][${log.args.tokenId}]`);
  });

  // One resolver per fleet in practice, but read it from the mint's own name
  // rather than assumed: `resolve()` returns whichever resolver the registry
  // currently points at, and that is the address the roles actually live on.
  const resolverAddress = (await (async () => {
    const first = names[0];
    const [, resolver] = await client.readContract({
      address: UNIVERSAL_RESOLVER_V2,
      abi: universalResolverAbi,
      functionName: "resolve",
      args: [first.dnsName, encodeFunctionData({ abi: resolverAbi, functionName: "addr", args: [first.node] })],
    });
    return resolver;
  })()) as Address;

  const heartbeatResources = names.map((n) => textResourceOf(n.node, RECORD_KEYS.heartbeat));

  const [records, textLogs, roleLogs, authorizations] = await Promise.all([
    readAllRecords(client, names, registrationKeys),
    client.getContractEvents({
      address: resolverAddress,
      abi: resolverEventsAbi,
      eventName: "TextChanged",
      args: { node: nodes },
      fromBlock,
      toBlock: "latest",
    }),
    client.getContractEvents({
      address: resolverAddress,
      abi: resolverEventsAbi,
      eventName: "EACRolesChanged",
      args: { resource: heartbeatResources },
      fromBlock,
      toBlock: "latest",
    }),
    // Whether each agent may still write its own heartbeat, asked of the resolver
    // that holds the role rather than of the minter's `isAgentAuthorized`.
    //
    // The minter's version takes `(registry, label, agent)`, and the registry is
    // not something this module has: `readFleet` is handed a parent *name*, and
    // turning that back into a registry address is another call and another way to
    // be wrong. The resolver is already resolved above and the resource is already
    // derived for the revocation filter below, so this asks the same question
    // where the answer actually lives, at no extra round trip. It also makes the
    // header of this file true — it has always claimed `hasRoles` is the third
    // source, and until now the code called the minter instead.
    //
    // This is the fourth silent failure in this module's history and the worst of
    // them: the previous call passed two arguments to a three-argument function,
    // `allowFailure: true` turned the encoding error into `status: "failure"`, and
    // the `false` fallback below rendered every capsule of a live fleet as
    // recalled. Nothing caught it — `tsc` cannot check arity through a mapped
    // array, and `scripts/check-fleet.ts` asserts agreement with the minter but
    // does so inside a per-capsule loop that never ran, because the parent it
    // checks had no capsules. Hence `hasRolesCall`: arity is enforced by a
    // function signature, which is the one thing here a type checker can see.
    client.multicall({
      contracts: mints.map((log, index) =>
        hasRolesCall(resolverAddress, heartbeatResources[index], log.args.agent as Address),
      ),
      allowFailure: true,
    }),
  ]);

  const wanted = new Set<bigint>();
  for (const log of mints) if (log.blockNumber !== null) wanted.add(log.blockNumber);
  for (const log of textLogs) if (log.blockNumber !== null) wanted.add(log.blockNumber);
  for (const log of roleLogs) if (log.blockNumber !== null) wanted.add(log.blockNumber);
  const times = await blockTimes(client, wanted);

  const capsules: Capsule[] = mints.map((mint, index) => {
    const { label, name, node } = names[index];
    const agent = mint.args.agent as Address;
    const read = records.get(name)!;

    const writes: ChainWrite[] = textLogs
      .filter((log) => (log.args.node as Hex) === node)
      .map((log) => ({
        key: log.args.key as string,
        value: log.args.value as string,
        block: log.blockNumber ?? 0n,
        tx: log.transactionHash ?? ("0x" as Hex),
        at: times.get(log.blockNumber ?? 0n) ?? null,
        byAgent: (log.args.key as string) === RECORD_KEYS.heartbeat,
      }))
      .sort((a, b) => Number(b.block - a.block));

    const beats = writes.filter((w) => w.byAgent).slice().reverse();
    const intervals: number[] = [];
    for (let i = 1; i < beats.length; i += 1) {
      const previous = beats[i - 1].at;
      const current = beats[i].at;
      if (previous !== null && current !== null) intervals.push(current - previous);
    }

    const lastBeat = beats.length > 0 ? beats[beats.length - 1] : null;
    const now = Math.floor(Date.now() / 1000);
    const quietFor = lastBeat?.at != null ? Math.max(0, now - lastBeat.at) : null;

    const authorization = authorizations[index];
    const authorized = authorization.status === "success" ? (authorization.result as boolean) : false;

    // The most recent revocation of ROLE_SET_TEXT on this name's heartbeat key.
    const resource = heartbeatResources[index];
    const revocations = roleLogs
      .filter((log) => {
        const args = log.args as { resource?: bigint; account?: Address; oldRoleBitmap?: bigint; newRoleBitmap?: bigint };
        return (
          args.resource === resource &&
          args.account?.toLowerCase() === agent.toLowerCase() &&
          (args.oldRoleBitmap! & ROLE_SET_TEXT) !== 0n &&
          (args.newRoleBitmap! & ROLE_SET_TEXT) === 0n
        );
      })
      .sort((a, b) => Number((b.blockNumber ?? 0n) - (a.blockNumber ?? 0n)));

    const lastRevocation = revocations[0];

    return {
      label,
      parent: parentName,
      name,
      node,
      tokenId: mint.args.tokenId as bigint,
      owner: mint.args.owner as Address,
      agent,
      expiry: Number(mint.args.expiry ?? 0n),
      mintedAt: {
        block: mint.blockNumber ?? 0n,
        tx: mint.transactionHash ?? ("0x" as Hex),
        at: times.get(mint.blockNumber ?? 0n) ?? null,
      },
      resolver: read.resolver === zeroAddress ? resolverAddress : read.resolver,
      addr: read.addr,
      records: read.records,
      registrationKey: registrationKeys.get(name)!,
      registrationValue: read.registration,
      authorized,
      status: deriveStatus(authorized, quietFor, median(intervals)),
      beatCount: beats.length,
      lastBeat,
      intervals,
      cadence: median(intervals),
      quietFor,
      recalledAt:
        !authorized && lastRevocation !== undefined
          ? {
              block: lastRevocation.blockNumber ?? 0n,
              tx: lastRevocation.transactionHash ?? ("0x" as Hex),
              at: times.get(lastRevocation.blockNumber ?? 0n) ?? null,
            }
          : null,
      writes,
    };
  });

  return {
    parent: parentName,
    minter,
    capsules,
    events: buildEvents(capsules, roleLogs, times, heartbeatResources, names),
    block: head,
    readAt: Math.floor(Date.now() / 1000),
  };
}

/** One capsule, by label. Reads the fleet — the queries are fleet-wide anyway. */
export async function readCapsule(
  client: PublicClient,
  label: string,
  config: FleetConfig,
): Promise<Capsule | null> {
  const fleet = await readFleet(client, config);
  return fleet.capsules.find((capsule) => capsule.label === label) ?? null;
}

/**
 * The activity feed: every mint, record write and role change, newest first.
 *
 * Heartbeats are folded into a single row per capsule rather than listed
 * individually. A capsule beating every 60 seconds would otherwise bury every
 * other event in the fleet within an hour, and the interesting row — a prompt
 * changed, a role pulled — is the one that gets pushed off the screen.
 */
function buildEvents(
  capsules: Capsule[],
  roleLogs: readonly { args: unknown; blockNumber: bigint | null; transactionHash: Hex | null }[],
  times: Map<bigint, number>,
  heartbeatResources: bigint[],
  names: { name: string }[],
): FleetEvent[] {
  const events: FleetEvent[] = [];

  for (const capsule of capsules) {
    events.push({
      id: `mint-${capsule.node}`,
      kind: "minted",
      name: capsule.name,
      text: "Minted",
      detail: `subname + ${RECORD_ENTRIES.length} records + heartbeat role`,
      block: capsule.mintedAt.block,
      at: capsule.mintedAt.at,
      tx: capsule.mintedAt.tx,
    });

    for (const write of capsule.writes) {
      if (write.byAgent) continue;
      if (write.block === capsule.mintedAt.block) continue; // written by the mint itself
      events.push({
        id: `write-${write.tx}-${write.key}`,
        kind: "record",
        name: capsule.name,
        text: `${write.key} changed`,
        detail: write.value.length > 48 ? `${write.value.slice(0, 45)}…` : write.value,
        block: write.block,
        at: write.at,
        tx: write.tx,
      });
    }

    if (capsule.lastBeat !== null) {
      events.push({
        id: `beat-${capsule.node}`,
        kind: "heartbeat",
        name: capsule.name,
        text: capsule.status === "recalled" ? "Heartbeat stopped" : "Heartbeat written",
        detail: `${capsule.lastBeat.value} · ${capsule.beatCount} write${capsule.beatCount === 1 ? "" : "s"} total`,
        block: capsule.lastBeat.block,
        at: capsule.lastBeat.at,
        tx: capsule.lastBeat.tx,
      });
    }
  }

  const nameOfResource = new Map(heartbeatResources.map((resource, index) => [resource, names[index].name]));
  for (const log of roleLogs) {
    const args = log.args as { resource?: bigint; account?: Address; oldRoleBitmap?: bigint; newRoleBitmap?: bigint };
    if (args.resource === undefined || args.oldRoleBitmap === undefined || args.newRoleBitmap === undefined) continue;
    const had = (args.oldRoleBitmap & ROLE_SET_TEXT) !== 0n;
    const has = (args.newRoleBitmap & ROLE_SET_TEXT) !== 0n;
    if (had === has) continue;
    events.push({
      id: `role-${log.transactionHash}-${args.account}-${args.newRoleBitmap}`,
      kind: has ? "granted" : "recalled",
      name: nameOfResource.get(args.resource) ?? "unknown",
      text: has ? "Heartbeat role granted" : "Recalled",
      detail: has
        ? `authorizeTextRoles(${RECORD_KEYS.heartbeat}, true)`
        : `authorizeTextRoles(${RECORD_KEYS.heartbeat}, false)`,
      block: log.blockNumber ?? 0n,
      at: times.get(log.blockNumber ?? 0n) ?? null,
      tx: log.transactionHash ?? ("0x" as Hex),
    });
  }

  return events.sort((a, b) => Number(b.block - a.block));
}

export { REGISTRATION_VALUE, parseHeartbeatSequence };
