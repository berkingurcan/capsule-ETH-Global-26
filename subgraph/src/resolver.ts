/**
 * `PermissionedResolver` — what each name says, and who is still allowed to say it.
 *
 * This is where the index earns its keep. Two of the three event streams the
 * fleet is made of come off this contract, on two completely different
 * cadences — a record write is an owner changing their mind, a heartbeat is a
 * machine proving it is alive — and a role change on a third. Joining them
 * over `eth_getLogs` means holding all of it in memory and reconciling it on
 * every page render. Joining them here means each event is measured against
 * the state the previous ones left behind, once, at index time.
 *
 * Two things that fall out of that and are the reason for most of this file:
 *
 *   `Heartbeat.interval`            seconds since the previous beat, known
 *                                   because the previous beat is already in
 *                                   the store.
 *   `RoleChange.secondsSinceLastBeat` seconds between the agent's last write
 *                                   and the owner pulling its permission.
 *                                   Two contracts' worth of events, one
 *                                   subtraction, and the whole question
 *                                   "did it die, or was it stopped?"
 *
 * ## A resolver is not a capsule
 *
 * Every owner gets their own `PermissionedResolver` and it serves every name
 * they hold, not only the ones the minter issued. So both record handlers
 * begin by asking whether this node is a capsule at all, and role changes go
 * through `ResourceRef` — `EACRolesChanged` carries a hashed resource and
 * nothing else, so a role change that cannot be attributed to a name this
 * subgraph minted is not ours to index.
 */
import { Address, BigInt, Bytes, dataSource, ethereum } from "@graphprotocol/graph-ts";
import {
  AddrChanged,
  AddressUpdated,
  EACRolesChanged,
  Linked,
  TextChanged,
  TextUpdated,
} from "../generated/templates/PermissionedResolver/PermissionedResolver";
import {
  AgentRef,
  Capsule,
  Heartbeat,
  RecordNode,
  RecordWrite,
  ResourceRef,
  RoleChange,
} from "../generated/schema";
import { loadFleet } from "./minter";
import {
  KEY_CLASS,
  KEY_CONTEXT,
  KEY_ENDPOINT_CAPSULE,
  KEY_ENDPOINT_WEB,
  KEY_HEARTBEAT,
  KEY_MODEL,
  KEY_PROMPT,
  KEY_REGISTRATION_PREFIX,
  KEY_RUNTIME,
  KEY_SCHEMA,
  KIND_HEARTBEAT,
  agentKey,
  eventId,
  holdsSetText,
  inodeResourceOf,
  parseHeartbeatSequence,
} from "./records";

/** ENSIP-9. 60 is Ethereum, and the address is then 20 raw bytes. */
const COIN_TYPE_ETH = BigInt.fromI32(60);

/* ------------------------------------------------------------------ *
 * The beta revision: records keyed by namehash, node in every event.  *
 * ------------------------------------------------------------------ */

export function handleTextChanged(event: TextChanged): void {
  applyTextWrite(event.params.node, event.params.key, event.params.value, event);
}

/**
 * The `addr` record — the identity link the runner refuses to boot without.
 *
 * `mint()` sets it to the agent, and the mint handler asserts that because
 * this event lands before `CapsuleMinted`. What reaches here is an owner
 * repointing a live capsule at a different address, which is worth seeing:
 * the runner treats an `addr` that is not itself as fatal.
 */
export function handleAddrChanged(event: AddrChanged): void {
  const capsule = Capsule.load(event.params.node);
  if (capsule == null) return;
  capsule.addr = event.params.a;
  capsule.save();
}

/* ------------------------------------------------------------------ *
 * The hackathon revision: records numbered, node only in `Linked`.    *
 * ------------------------------------------------------------------ */

/**
 * The record id -> node binding, kept because it is said exactly once.
 *
 * `Linked` also fires when an alias node is pointed at an existing record, so
 * one id can name several nodes. A capsule's own node always wins that tie;
 * otherwise the first binding stands. At mint the first `Linked` arrives
 * before `CapsuleMinted` — `setAddress` creates the record — so the capsule
 * does not exist yet and the `existing == null` branch is the one that runs.
 */
export function handleLinked(event: Linked): void {
  const id = recordKey(event.address, event.params.recordId);
  const existing = RecordNode.load(id);
  if (existing != null && Capsule.load(event.params.node) == null) return;

  const record = existing == null ? new RecordNode(id) : (existing as RecordNode);
  record.resolver = event.address;
  record.recordId = event.params.recordId;
  record.node = event.params.node;
  record.save();
}

export function handleTextUpdated(event: TextUpdated): void {
  const node = nodeOfRecord(event.address, event.params.recordId);
  if (node === null) return;
  applyTextWrite(node as Bytes, event.params.key, event.params.value, event);
}

/**
 * The hackathon spelling of `AddrChanged`, and a wider one: this resolver
 * publishes an address per ENSIP-9 coin type, so most of these events are
 * about some other chain entirely. Only coin type 60 is this capsule's
 * identity.
 */
export function handleAddressUpdated(event: AddressUpdated): void {
  if (event.params.coinType.notEqual(COIN_TYPE_ETH)) return;

  const node = nodeOfRecord(event.address, event.params.recordId);
  if (node === null) return;
  const capsule = Capsule.load(node as Bytes);
  if (capsule == null) return;

  // A cleared record is zero-length, not twenty zero bytes, and `changetype`
  // on anything but twenty bytes would read off the end of the buffer.
  const raw = event.params.addressBytes;
  capsule.addr = raw.length == 20 ? changetype<Address>(raw) : Address.zero();
  capsule.save();
}

/** `<resolver>-<recordId>` — see `RecordNode` in the schema for why. */
function recordKey(resolver: Address, recordId: BigInt): string {
  return resolver.toHexString() + "-" + recordId.toString();
}

function nodeOfRecord(resolver: Address, recordId: BigInt): Bytes | null {
  const record = RecordNode.load(recordKey(resolver, recordId));
  // Only reachable for a record created before this subgraph's startBlock, so
  // whose `Linked` was never seen. Every capsule's record is created by the
  // mint that this index is pointed at, so not for one of ours.
  if (record == null) return null;
  return record.node;
}

/* ------------------------------------------------------------------ *
 * Shared. Both revisions reduce to (node, key, value) plus the event. *
 * ------------------------------------------------------------------ */

/**
 * One text record written, whichever resolver revision said so.
 *
 * Takes `ethereum.Event` rather than either concrete event type: the block,
 * the transaction and the log index are all on the base class, and the three
 * fields that are not are exactly the three parameters above. AssemblyScript
 * has no union types, so the alternative is two copies of this function that
 * drift.
 */
function applyTextWrite(node: Bytes, key: string, value: string, event: ethereum.Event): void {
  const capsule = Capsule.load(node);
  if (capsule == null) return; // not a capsule — the owner's other names live here too

  const writer = event.transaction.from;
  const isHeartbeat = key == KEY_HEARTBEAT;
  // The chain-scanning read path infers this from the key, because a log does
  // not carry a sender. Here it is the actual signer, which is the difference
  // between "this was the heartbeat key so presumably the agent" and knowing.
  const byAgent = writer.equals(capsule.agent);

  const write = new RecordWrite(eventId(event.transaction.hash, event.logIndex));
  write.capsule = capsule.id;
  write.key = key;
  write.value = value;
  write.writer = writer;
  write.byAgent = byAgent;
  write.isHeartbeat = isHeartbeat;
  write.block = event.block.number;
  write.timestamp = event.block.timestamp;
  write.tx = event.transaction.hash;
  write.logIndex = event.logIndex;
  write.save();

  applyRecord(capsule, key, value);

  if (isHeartbeat) {
    recordHeartbeat(capsule, value, event);
  } else {
    capsule.configWriteCount = capsule.configWriteCount + 1;
    capsule.lastConfigChangeAt = event.block.timestamp;
  }
  if (!byAgent) capsule.ownerWriteCount = capsule.ownerWriteCount + 1;
  capsule.save();

  const fleet = loadFleet(minterOf(), event.block.timestamp, event.block.number);
  fleet.recordWriteCount = fleet.recordWriteCount + 1;
  if (isHeartbeat) fleet.beatCount = fleet.beatCount + 1;
  fleet.save();
}

/**
 * Mirror the record onto the capsule, so current state is one read.
 *
 * The `agent-registration[<registry>][<agentId>]` key is matched by prefix
 * rather than by equality: the registry half is the minter as an ERC-7930
 * interoperable address and the agent half is a tokenId, so the whole string
 * is only knowable per capsule. Reading it back off the write is cheaper and
 * more honest than rebuilding it here from a constant that goes stale on
 * every minter redeploy.
 */
function applyRecord(capsule: Capsule, key: string, value: string): void {
  if (key == KEY_CLASS) capsule.nodeClass = value;
  else if (key == KEY_SCHEMA) capsule.schemaUri = value;
  else if (key == KEY_CONTEXT) capsule.context = value;
  else if (key == KEY_ENDPOINT_WEB) capsule.endpointWeb = value;
  else if (key == KEY_ENDPOINT_CAPSULE) capsule.endpointCapsule = value;
  else if (key == KEY_MODEL) capsule.model = value;
  else if (key == KEY_RUNTIME) capsule.runtime = value;
  else if (key == KEY_PROMPT) capsule.prompt = value;
  else if (key == KEY_HEARTBEAT) capsule.heartbeat = value;
  else if (key.startsWith(KEY_REGISTRATION_PREFIX)) {
    capsule.registrationKey = key;
    capsule.registrationValue = value;
  }
}

/**
 * One beat, and the gap that preceded it.
 *
 * The gap is the only thing here that cannot be read off a single event. A
 * cadence is not on chain at all — `HEARTBEAT_SECONDS` lives in the runner's
 * environment, and the demo runs at 60s against a documented default of
 * 28800 — so an interval is only ever observed, and observing it needs the
 * beat before this one. Which the store already has.
 */
function recordHeartbeat(capsule: Capsule, value: string, event: ethereum.Event): void {
  const previous = capsule.lastBeatAt;
  const timestamp = event.block.timestamp;

  const beat = new Heartbeat(eventId(event.transaction.hash, event.logIndex));
  beat.capsule = capsule.id;
  beat.sequence = parseHeartbeatSequence(value);
  beat.value = value;
  beat.interval = previous === null ? null : timestamp.minus(previous as BigInt);
  beat.block = event.block.number;
  beat.timestamp = timestamp;
  beat.tx = event.transaction.hash;
  beat.save();

  if (previous === null) capsule.firstBeatAt = timestamp;
  else capsule.lastInterval = timestamp.minus(previous as BigInt);

  capsule.beatCount = capsule.beatCount + 1;
  capsule.lastBeatAt = timestamp;
  capsule.lastBeatValue = value;
  capsule.lastBeatSequence = beat.sequence;
  capsule.lastBeatTx = event.transaction.hash;
}

/**
 * The kill switch, and the join it makes possible.
 *
 * `EACRolesChanged` is `(resource, account, oldRoleBitmap, newRoleBitmap)` on
 * both revisions, and on both the event names no capsule. What differs is how
 * it can be made to.
 *
 * On the beta the resource is `keccak256(abi.encode(node, keccak256(key)))`,
 * unique per (name, key), and `ResourceRef` — written at mint for both of a
 * capsule's resources — is the way back.
 *
 * On the hackathon revision it is `keccak256(key)` and the name is not in it,
 * so one resource covers every capsule the resolver serves and `ResourceRef`
 * would be a lie. `(resolver, account)` is used instead, and the resource is
 * then only asked whether this was about the heartbeat at all.
 *
 * That pair can name several capsules, and when it does they are ALL recalled
 * by one event — `setText` checks `resource(key)` and nothing else, so an
 * agent that loses the role loses it everywhere on that resolver. Hence the
 * loop. Attributing such an event to one capsule would leave its siblings
 * reading as live while holding a key that can no longer write, which is the
 * precise failure this index exists to make visible.
 *
 * That path deliberately sees only the agent's own roles. The minter grants
 * the owner no name-level roles on this revision — it cannot, since a
 * name-level resource does not exist there — so there is nothing else under a
 * capsule to index.
 *
 * Only a change in `ROLE_SET_TEXT` is interesting either way. The resolver
 * emits this event for every role in the bitmap, including admin roles the
 * owner holds on their own name, and a bitmap that gained an unrelated role
 * is not a recall.
 */
export function handleRolesChanged(event: EACRolesChanged): void {
  const resource = event.params.resource.toString();

  let targets: Bytes[] = [];
  let resourceKind = "";

  const ref = ResourceRef.load(resource);
  if (ref != null) {
    targets = [ref.capsule];
    resourceKind = ref.kind;
  } else {
    // Not a beta resource. Only the heartbeat key is worth chasing on the
    // hackathon side, and checking it first means one keccak instead of a
    // store read for every unrelated role change on the resolver.
    if (resource != inodeResourceOf(KEY_HEARTBEAT)) return;
    const agentRef = AgentRef.load(agentKey(event.address, event.params.account));
    if (agentRef == null) return; // not an agent this subgraph minted
    // Every capsule this key beats for, because one revoke stops all of them.
    targets = agentRef.capsules;
    resourceKind = KIND_HEARTBEAT;
  }

  const had = holdsSetText(event.params.oldRoleBitmap);
  const has = holdsSetText(event.params.newRoleBitmap);
  if (had == has) return; // the write-a-record permission did not move

  for (let i = 0; i < targets.length; i++) {
    const capsule = Capsule.load(targets[i]);
    if (capsule == null) continue;
    applyRoleChange(capsule as Capsule, resourceKind, has, event);
  }
}

/** One capsule's share of a role change. Several may come off one event. */
function applyRoleChange(
  cap: Capsule,
  resourceKind: string,
  has: boolean,
  event: EACRolesChanged,
): void {
  const account = event.params.account;
  const isAgent = account.equals(cap.agent);
  const lastBeat = cap.lastBeatAt;

  // The capsule is part of the id, not just the event: one revoke can recall
  // several capsules, and `tx ++ logIndex` alone would have them overwrite
  // each other down to a single row.
  const change = new RoleChange(eventId(event.transaction.hash, event.logIndex).concat(cap.id));
  change.capsule = cap.id;
  change.resourceKind = resourceKind;
  change.account = account;
  change.changedBy = event.transaction.from;
  change.oldRoleBitmap = event.params.oldRoleBitmap;
  change.newRoleBitmap = event.params.newRoleBitmap;
  change.granted = has;
  change.revoked = !has;
  change.isAgent = isAgent;
  // The whole reason this subgraph exists. `agent-heartbeat` writes come off
  // one contract on the agent's schedule; role changes come off another on
  // the owner's. Nothing emits both, and this is the distance between them.
  change.secondsSinceLastBeat =
    lastBeat === null ? null : event.block.timestamp.minus(lastBeat as BigInt);
  change.beatsAtChange = cap.beatCount;
  change.block = event.block.number;
  change.timestamp = event.block.timestamp;
  change.tx = event.transaction.hash;
  change.save();

  // Only the agent's own grip on its own heartbeat key is the kill switch.
  // The owner gaining or losing an admin role on the name is a real event and
  // is recorded above, but it does not stop the agent writing.
  if (resourceKind != KIND_HEARTBEAT || !isAgent) return;

  const wasAuthorized = cap.authorized;
  cap.authorized = has;
  if (!has) {
    cap.recallCount = cap.recallCount + 1;
    cap.recalledAt = event.block.timestamp;
    cap.recalledAtBlock = event.block.number;
    cap.recalledTx = event.transaction.hash;
  } else {
    // Regranted. The recall is still in `roleChanges` and `recallCount` still
    // counts it; what is cleared is the claim that this capsule is recalled
    // *now*, which is a different question and the one the dashboard asks.
    cap.recalledAt = null;
    cap.recalledAtBlock = null;
    cap.recalledTx = null;
  }
  cap.save();

  const fleet = loadFleet(minterOf(), event.block.timestamp, event.block.number);
  if (!has) {
    fleet.recallCount = fleet.recallCount + 1;
    if (wasAuthorized) fleet.authorizedCount = fleet.authorizedCount - 1;
  } else if (!wasAuthorized) {
    fleet.authorizedCount = fleet.authorizedCount + 1;
  }
  fleet.save();
}

/**
 * Which `Fleet` row to count against.
 *
 * The resolver's events do not name the minter, and a template data source
 * has no address for the static one that spawned it. So the minter travels
 * with the data source: `ensureResolverIndexed` puts it in the context at
 * creation, and it comes back out here. The alternative — a second copy of
 * the address in this file — would land the resolver's totals on a different
 * `Fleet` row than the mint handler's the first time the minter is
 * redeployed, and both rows would look plausible.
 */
function minterOf(): Bytes {
  return dataSource.context().getBytes("minter");
}
