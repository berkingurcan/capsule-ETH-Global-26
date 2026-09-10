/**
 * `CapsuleMinter` — which names exist, who owns them, and where their records live.
 *
 * Three handlers, and the ordering constraint between them is the only subtle
 * thing in this file.
 *
 * ## Why the mint handler back-fills state it never sees an event for
 *
 * `mint()` emits `CapsuleMinted` at the END of `_registerAndDelegate`, after
 * it has already called `authorizeNameRoles`, `authorizeTextRoles` and
 * `setAddr`. So within the mint transaction the log order is:
 *
 *   EACRolesChanged (owner gets the name)   <- resolver, before CapsuleMinted
 *   EACRolesChanged (agent gets one key)    <- resolver, before CapsuleMinted
 *   AddrChanged                             <- resolver, before CapsuleMinted
 *   CapsuleMinted                           <- this file
 *   TextChanged x9                          <- resolver, after CapsuleMinted
 *
 * The resolver handlers return early for a node with no `Capsule`, so the
 * three that land first are dropped on the floor — there is nothing to attach
 * them to yet. That is not a loss, because `mint()` grants exactly those
 * roles and writes exactly that addr every time, so this handler asserts them
 * directly. Anything a later transaction changes is then indexed normally.
 *
 * The nine `TextChanged` come after and are indexed the ordinary way, which
 * is why record values are not repeated in `CapsuleMinted` and are not
 * duplicated here either.
 */
import { Address, BigInt, Bytes, DataSourceContext, log } from "@graphprotocol/graph-ts";
import {
  CapsuleMinted,
  CapsuleMinter,
  ParentConnected,
  ParentDisconnected,
} from "../generated/CapsuleMinter/CapsuleMinter";
import { PermissionedResolver } from "../generated/templates";
import {
  Capsule,
  Fleet,
  Parent,
  ParentByNode,
  ResolverSource,
  ResourceRef,
} from "../generated/schema";
import {
  KEY_HEARTBEAT,
  KIND_HEARTBEAT,
  KIND_NAME,
  decodeDnsName,
  nameResourceOf,
  textResourceOf,
} from "./records";

/** The one `Fleet` row, keyed by the minter this subgraph is pointed at. */
export function loadFleet(minter: Bytes, timestamp: BigInt, block: BigInt): Fleet {
  let fleet = Fleet.load(minter);
  if (fleet == null) {
    fleet = new Fleet(minter);
    fleet.parentCount = 0;
    fleet.capsuleCount = 0;
    fleet.authorizedCount = 0;
    fleet.beatCount = 0;
    fleet.recallCount = 0;
    fleet.recordWriteCount = 0;
  }
  fleet.lastEventAt = timestamp;
  fleet.lastEventBlock = block;
  return fleet as Fleet;
}

/**
 * A name joins the minter — and this is where the resolver becomes knowable.
 *
 * Also fired by `setParentOpen`, which re-emits the same event to flip one
 * boolean, so everything here is written to be idempotent.
 */
export function handleParentConnected(event: ParentConnected): void {
  const registry = event.params.registry;
  const resolver = event.params.resolver;

  const existing = Parent.load(registry);
  const isNew = existing == null;
  const parent = existing == null ? new Parent(registry) : (existing as Parent);
  if (isNew) {
    parent.capsuleCount = 0;
    parent.connectedAt = event.block.timestamp;
    parent.connectedAtBlock = event.block.number;
    parent.name = "";
    parent.dnsName = Bytes.empty();
  }

  parent.node = event.params.parentNode;
  parent.resolver = resolver;
  parent.open = event.params.open;
  parent.connected = true;
  parent.connectedBy = event.params.by;

  // One `eth_call`, on an event that fires when a human connects a name —
  // not per capsule and not per block. It buys the parent's DNS wire name,
  // which `ParentConnected` does not carry and which nothing else on chain
  // publishes in a form this subgraph can reach. Without it every capsule
  // here would be a bare label.
  const minter = CapsuleMinter.bind(event.address);
  const stored = minter.try_parentOf(registry);
  if (stored.reverted) {
    // Never observed — the event is emitted from inside the write that
    // populates the mapping — but a reverted call must not take the whole
    // subgraph down, and a label-only fleet is still a fleet.
    log.warning("parentOf({}) reverted; parent name unknown", [registry.toHexString()]);
  } else {
    parent.dnsName = stored.value.getDnsName();
    parent.name = decodeDnsName(stored.value.getDnsName());
  }
  parent.save();

  // parentNode -> Parent, so `CapsuleMinted` can find its parent from the
  // only identifier it carries.
  const byNode = new ParentByNode(event.params.parentNode);
  byNode.parent = registry;
  byNode.save();

  ensureResolverIndexed(resolver, event.address, event.block.number);

  const fleet = loadFleet(event.address, event.block.timestamp, event.block.number);
  if (isNew) fleet.parentCount = fleet.parentCount + 1;
  fleet.save();
}

/**
 * A name withdraws. Cosmetic on chain and cosmetic here: capsules already
 * minted keep their records, their owner's roles and their agent's one key,
 * so nothing about them changes and they stay in the index.
 */
export function handleParentDisconnected(event: ParentDisconnected): void {
  const parent = Parent.load(event.params.registry);
  if (parent == null) return;
  parent.connected = false;
  parent.save();

  const fleet = loadFleet(event.address, event.block.timestamp, event.block.number);
  fleet.save();
}

export function handleCapsuleMinted(event: CapsuleMinted): void {
  const node = event.params.node;

  const byNode = ParentByNode.load(event.params.parentNode);
  if (byNode == null) {
    // `mint()` reverts with ParentNotConnected unless a ParentConnected has
    // landed first, so this is unreachable short of a reorg that dropped the
    // connect. Refusing to invent a parent is better than a capsule hanging
    // off a name this index made up.
    log.error("capsule {} minted under unknown parent {}", [
      node.toHexString(),
      event.params.parentNode.toHexString(),
    ]);
    return;
  }
  const parent = Parent.load(byNode.parent);
  if (parent == null) return;

  const label = event.params.label;
  const capsule = new Capsule(node);
  capsule.parent = parent.id;
  capsule.label = label;
  capsule.name = parent.name == "" ? label : label + "." + parent.name;
  capsule.tokenId = event.params.tokenId;
  capsule.owner = event.params.owner;
  capsule.agent = event.params.agent;
  // `mint()` calls `setAddr(node, agent)` two statements before it emits this
  // event, so the AddrChanged for it was seen before the capsule existed.
  // Asserted here rather than lost; a later rewrite is indexed normally.
  capsule.addr = event.params.agent;
  capsule.expiry = event.params.expiry;
  capsule.resolver = parent.resolver;

  capsule.mintedAt = event.block.timestamp;
  capsule.mintedAtBlock = event.block.number;
  capsule.mintTx = event.transaction.hash;

  // The nine `setText` calls land after this event and fill these in.
  capsule.nodeClass = "";
  capsule.schemaUri = "";
  capsule.context = "";
  capsule.endpointWeb = "";
  capsule.endpointCapsule = "";
  capsule.model = "";
  capsule.runtime = "";
  capsule.prompt = "";
  capsule.heartbeat = "";
  capsule.registrationKey = "";
  capsule.registrationValue = "";

  const heartbeatResource = textResourceOf(node, KEY_HEARTBEAT);
  const nameResource = nameResourceOf(node);
  capsule.heartbeatResource = heartbeatResource;
  capsule.nameResource = nameResource;
  // `mint()` grants the agent ROLE_SET_TEXT on the heartbeat key in the same
  // transaction, before this event. See the note at the top of the file.
  capsule.authorized = true;
  capsule.recallCount = 0;

  capsule.beatCount = 0;
  capsule.lastBeatValue = "";
  capsule.lastBeatSequence = BigInt.zero();

  capsule.configWriteCount = 0;
  capsule.ownerWriteCount = 0;
  capsule.save();

  // The two resources a role change can arrive on, so `EACRolesChanged` —
  // which carries a hash and nothing else — can be attributed to this name.
  addResourceRef(heartbeatResource, node, KIND_HEARTBEAT);
  addResourceRef(nameResource, node, KIND_NAME);

  parent.capsuleCount = parent.capsuleCount + 1;
  parent.save();

  // A capsule can be minted under a parent whose resolver template was
  // created in an earlier block, which is the normal path. This covers the
  // case where it was not — a parent connected and minted under in the same
  // block — and is a no-op otherwise.
  ensureResolverIndexed(changetype<Address>(parent.resolver), event.address, event.block.number);

  const fleet = loadFleet(event.address, event.block.timestamp, event.block.number);
  fleet.capsuleCount = fleet.capsuleCount + 1;
  fleet.authorizedCount = fleet.authorizedCount + 1;
  fleet.save();
}

/**
 * Start indexing a `PermissionedResolver`, once.
 *
 * `ParentConnected` is re-emitted by `setParentOpen`, and one resolver can
 * serve several parents. Creating the data source twice would index every
 * `TextChanged` twice — which does not error, it just doubles every count in
 * the index.
 */
function ensureResolverIndexed(resolver: Address, minter: Address, block: BigInt): void {
  if (ResolverSource.load(resolver) != null) return;
  const source = new ResolverSource(resolver);
  source.createdAtBlock = block;
  source.save();

  // The minter travels with the data source rather than being spelled a
  // second time in the resolver mapping. A template handler has no address
  // for the static source that spawned it, and the `Fleet` totals it updates
  // have to land on the row the mint handler writes — a hardcoded copy here
  // and in the manifest would split them in two the first time the minter is
  // redeployed, silently, into two rows that each look plausible.
  const context = new DataSourceContext();
  context.setBytes("minter", minter);
  PermissionedResolver.createWithContext(resolver, context);
}

function addResourceRef(resource: string, node: Bytes, kind: string): void {
  if (ResourceRef.load(resource) != null) return;
  const ref = new ResourceRef(resource);
  ref.capsule = node;
  ref.kind = kind;
  ref.save();
}
