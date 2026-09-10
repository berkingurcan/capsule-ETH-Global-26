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
import { BigInt, Bytes, dataSource } from "@graphprotocol/graph-ts";
import {
  AddrChanged,
  EACRolesChanged,
  TextChanged,
} from "../generated/templates/PermissionedResolver/PermissionedResolver";
import { Capsule, Heartbeat, RecordWrite, ResourceRef, RoleChange } from "../generated/schema";
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
  eventId,
  holdsSetText,
  parseHeartbeatSequence,
} from "./records";

export function handleTextChanged(event: TextChanged): void {
  const capsule = Capsule.load(event.params.node);
  if (capsule == null) return; // not a capsule — the owner's other names live here too

  const key = event.params.key;
  const value = event.params.value;
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
    recordHeartbeat(capsule, event);
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
function recordHeartbeat(capsule: Capsule, event: TextChanged): void {
  const previous = capsule.lastBeatAt;
  const timestamp = event.block.timestamp;

  const beat = new Heartbeat(eventId(event.transaction.hash, event.logIndex));
  beat.capsule = capsule.id;
  beat.sequence = parseHeartbeatSequence(event.params.value);
  beat.value = event.params.value;
  beat.interval = previous === null ? null : timestamp.minus(previous as BigInt);
  beat.block = event.block.number;
  beat.timestamp = timestamp;
  beat.tx = event.transaction.hash;
  beat.save();

  if (previous === null) capsule.firstBeatAt = timestamp;
  else capsule.lastInterval = timestamp.minus(previous as BigInt);

  capsule.beatCount = capsule.beatCount + 1;
  capsule.lastBeatAt = timestamp;
  capsule.lastBeatValue = event.params.value;
  capsule.lastBeatSequence = beat.sequence;
  capsule.lastBeatTx = event.transaction.hash;
}

/**
 * The kill switch, and the join it makes possible.
 *
 * `EACRolesChanged` is `(resource, account, oldRoleBitmap, newRoleBitmap)`.
 * The resource is `keccak256(abi.encode(node, keccak256(key)))`, so nothing in
 * the event names the capsule — `ResourceRef`, written at mint for both of a
 * capsule's resources, is the only way back to it.
 *
 * Only a change in `ROLE_SET_TEXT` is interesting. The resolver emits this
 * event for every role in the bitmap, including admin roles the owner holds
 * on their own name, and a bitmap that gained an unrelated role is not a
 * recall.
 */
export function handleRolesChanged(event: EACRolesChanged): void {
  const ref = ResourceRef.load(event.params.resource.toString());
  if (ref == null) return; // a resource on some name this subgraph never minted

  const capsule = Capsule.load(ref.capsule);
  if (capsule == null) return;

  const had = holdsSetText(event.params.oldRoleBitmap);
  const has = holdsSetText(event.params.newRoleBitmap);
  if (had == has) return; // the write-a-record permission did not move

  const account = event.params.account;
  const isAgent = account.equals(capsule.agent);
  const lastBeat = capsule.lastBeatAt;

  const change = new RoleChange(eventId(event.transaction.hash, event.logIndex));
  change.capsule = capsule.id;
  change.resourceKind = ref.kind;
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
  change.beatsAtChange = capsule.beatCount;
  change.block = event.block.number;
  change.timestamp = event.block.timestamp;
  change.tx = event.transaction.hash;
  change.save();

  // Only the agent's own grip on its own heartbeat key is the kill switch.
  // The owner gaining or losing an admin role on the name is a real event and
  // is recorded above, but it does not stop the agent writing.
  if (ref.kind != KIND_HEARTBEAT || !isAgent) return;

  const wasAuthorized = capsule.authorized;
  capsule.authorized = has;
  if (!has) {
    capsule.recallCount = capsule.recallCount + 1;
    capsule.recalledAt = event.block.timestamp;
    capsule.recalledAtBlock = event.block.number;
    capsule.recalledTx = event.transaction.hash;
  } else {
    // Regranted. The recall is still in `roleChanges` and `recallCount` still
    // counts it; what is cleared is the claim that this capsule is recalled
    // *now*, which is a different question and the one the dashboard asks.
    capsule.recalledAt = null;
    capsule.recalledAtBlock = null;
    capsule.recalledTx = null;
  }
  capsule.save();

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
