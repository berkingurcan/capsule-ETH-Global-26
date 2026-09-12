/**
 * Parents: turning an ENS name into something `CapsuleMinter` can be pointed at.
 *
 * A capsule is a subname, so every capsule has a parent, and since the minter
 * stopped being welded to one it needs to be told which. This module is how the
 * rest of the app asks that question, and there is exactly one answer path:
 *
 *     "berkin.eth"
 *       -> label "berkin"
 *       -> ETH_REGISTRY.getSubregistry("berkin")   -> the parent's registry
 *       -> minter.parentOf(registry)               -> resolver, node, open
 *       -> minter.readiness(registry, account)     -> may this person mint here
 *
 * ## Why the registry is the identity of a parent, and the name is not
 *
 * `mint()` takes a registry address. It could have taken a name, and a name is
 * what a person types — but a name is a string that has to be resolved to a
 * registry by *someone*, and the only question is whether that someone is this
 * app or the contract. Doing it here means the contract stores one address per
 * parent and cannot be handed a mismatched (registry, resolver, name) triple;
 * doing it there would mean a namehash-to-registry walk inside a mint, paid for
 * on every capsule, to reach the same address this module already knows.
 *
 * So: names are a UI concern, resolved once at the edge. Everything below the
 * form speaks registry addresses.
 *
 * Client-safe. No env, no secrets, no server RPC — the /connect page runs all of
 * this in the browser against the user's own wallet client.
 */
import { hexToBytes, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { namehash, normalize, packetToBytes } from "viem/ens";
import { toHex } from "viem";
import {
  ACTIVE,
  deploymentOfName,
  type DeploymentAddresses,
  ROLE_REGISTRAR,
  ROLE_REGISTRAR_ADMIN,
  ROLE_SET_SUBREGISTRY,
  ethRegistrarAbi,
  minterAbi,
  registryAbi,
} from "./chain";

/**
 * A parent name, in the three encodings anything on chain will ask for.
 *
 * The same trio `resolve.ts` builds for a capsule name, plus the label — which
 * only the parent needs, because the label is what `ETHRegistry` is keyed by.
 */
export type ParentName = {
  /** Normalised. `"Berkin.ETH"` and `"berkin.eth"` are the same parent. */
  name: string;
  /** `"berkin"` — the second-level label, the key into `ETH_REGISTRY`. */
  label: string;
  node: Hex;
  dnsName: Hex;
};

/**
 * Everything wrong with a name someone typed into the parent field.
 *
 * Every problem at once rather than the first, and phrased for a person who
 * knows they own a name and does not know what a subregistry is.
 *
 * Second-level `.eth` only, which is a real restriction and worth being honest
 * about: `dev.berkin.eth` could in principle host `bot.dev.berkin.eth`, and the
 * contract would handle it — `connectParent` verifies the registry link at any
 * depth. The limit is here because `ETH_REGISTRY.getSubregistry` takes a single
 * label, so resolving a deeper name to its registry means walking the chain a
 * level at a time, and nothing in this hackathon's scope needs it.
 */
export function parentNameProblems(raw: string): string[] {
  const value = raw.trim();
  if (value === "") return ["a parent name is required"];

  let normalized: string;
  try {
    normalized = normalize(value);
  } catch {
    return ["is not a valid ENS name"];
  }
  if (normalized !== value.toLowerCase()) {
    // Not rejected for case — the field lowercases as you type — but a name that
    // survives normalisation as something else entirely is one the user did not
    // mean to type, and minting under it would surprise them.
    if (normalize(value.toLowerCase()) !== value.toLowerCase()) {
      return [`is not in normalised ENS form — did you mean ${normalized}?`];
    }
  }

  const parts = normalized.split(".");
  if (parts.length !== 2 || parts[1] !== "eth") {
    return ["must be a second-level .eth name, such as berkin.eth"];
  }
  if (parts[0] === "") return ["is missing a label before .eth"];
  return [];
}

/** The three encodings. Throws on a name `parentNameProblems` would reject. */
export function encodeParent(raw: string): ParentName {
  const problems = parentNameProblems(raw);
  if (problems.length > 0) throw new Error(`${raw} ${problems[0]}`);
  const name = normalize(raw.trim());
  return {
    name,
    label: name.split(".")[0],
    node: namehash(name),
    dnsName: toHex(packetToBytes(name)),
  };
}

/**
 * The registry that issues `<name>`'s subnames, or null if it has none.
 *
 * Null is a real and common answer, not an error: a freshly registered `.eth`
 * name has no subregistry until its owner deploys one, and until then nobody
 * can mint anything under it. It is reported distinctly rather than folded into
 * "not ready" because it is the only blocker with a different actor — every
 * other step on /connect is a grant, and this one is a deployment.
 */
export async function readParentRegistry(
  client: PublicClient,
  parent: ParentName,
  deployment: DeploymentAddresses = ACTIVE,
): Promise<Address | null> {
  const registry = await client.readContract({
    address: deployment.ethRegistry,
    abi: registryAbi,
    functionName: "getSubregistry",
    args: [parent.label],
  });
  return registry === zeroAddress ? null : registry;
}

/**
 * What a parent's setup looks like right now, for one account.
 *
 * The single read the /connect page and the launch form both gate on. Every
 * field is a separate on-chain fact rather than one `ready` boolean, because
 * each one has a different fix and the whole point of the page is to say which
 * fix is outstanding.
 */
export type ParentStatus = {
  parent: ParentName;
  /**
   * Which ENSv2 deployment this name actually lives on.
   *
   * Detected from the name rather than configured, because both deployments are
   * live on Sepolia at once and a name exists on exactly one of them. Every
   * subsequent call in /connect is addressed using this — the registry to attach
   * to, the factory to deploy through, the resolver ABI to speak — so that a
   * name registered on the ENS hackathon portal and a name registered on the
   * beta both work without the user knowing there is a difference.
   *
   * Falls back to the active deployment for a name nobody has registered, where
   * there is no fact to detect and the only sensible guess is where /register
   * would put it.
   */
  deployment: DeploymentAddresses;
  /**
   * Whether the name exists at all.
   *
   * Kept separate from `registry` because the two failures look identical on a
   * checklist and are nothing alike: a name nobody has bought is one purchase
   * away from working, and a name with no subregistry is a dead end its owner
   * has to dig out of. Collapsing them tells someone who simply has not
   * registered yet that their name has a permissions problem.
   *
   * Read from the registrar's `isAvailable`, which is also what decides whether
   * /register would accept it, so the two pages cannot disagree about whether a
   * name is free.
   */
  registered: boolean;
  /** Null when the name has no subregistry — nothing else can be true yet. */
  registry: Address | null;
  /**
   * The name's ERC-1155 token id on `ETH_REGISTRY`, or null if it is not
   * registered.
   *
   * Needed because `setSubregistry` is gated per token rather than per name: the
   * role the registrar granted the owner is scoped to this id, so both the
   * permission check below and the transaction itself are addressed by it.
   */
  tokenId: bigint | null;
  /**
   * Whether this account may give the name a subregistry.
   *
   * The registrar grants `ROLE_SET_SUBREGISTRY` to the buyer at registration, so
   * for the owner this is true and for everyone else it is false — which is the
   * difference between "you have one step left" and "ask whoever owns this name
   * to do it", and those are not the same page.
   */
  callerMaySetSubregistry: boolean;
  /**
   * Whether the registry points back at this name.
   *
   * The child -> parent half of the link, read from the registry's own
   * `getParent`. Tracked separately from `registry` because a registry that is
   * attached but has never been told its parent looks completely wired — the
   * name has a subregistry, subnames resolve — and then fails every record write
   * with an error that blames the resolver. A connect interrupted between the
   * two transactions lands here, so it is a state to detect and finish, not an
   * anomaly.
   */
  parentLinked: boolean;
  /** `connectParent` has been called for this registry. */
  connected: boolean;
  /** The minter holds `ROLE_REGISTRAR` on the registry. */
  registrarGranted: boolean;
  /** The minter holds all four root roles on the parent's resolver. */
  resolverRolesGranted: boolean;
  /** Anybody may mint here, versus only the parent's own admins. */
  open: boolean;
  /** The account holds `ROLE_REGISTRAR_ADMIN` — it may connect and configure. */
  callerIsAdmin: boolean;
  /** The account would get past `mint()`'s check today. */
  callerMayMint: boolean;
  /** The resolver stored at connect time. Zero until connected. */
  resolver: Address;
  /** The parent node the minter derived from the DNS name at connect time. */
  node: Hex;
};

/**
 * Reads a parent's whole setup in one pass.
 *
 * `readiness` answers four of these on its own; `parentOf` supplies the stored
 * resolver and node, and `hasRoles` the caller's admin bit. They are batched
 * rather than chained because `createServerClient` and the browser client both
 * fold concurrent reads into one Multicall3 call, so three reads cost one round
 * trip and the page paints once.
 */
export async function readParentStatus(
  client: PublicClient,
  minter: Address,
  parent: ParentName,
  account: Address,
): Promise<ParentStatus> {
  /* Which deployment owns this label, before anything is asked about it. Every
     read below is addressed relative to the answer, so a hackathon-registered
     name is never interrogated against the beta's registry — which is what made
     portal-minted names look unregistered here. */
  const deployment = (await deploymentOfName(client, parent.label)) ?? ACTIVE;

  const [registry, available, tokenId] = await Promise.all([
    readParentRegistry(client, parent, deployment),
    client.readContract({
      address: deployment.ethRegistrar,
      abi: ethRegistrarAbi,
      functionName: "isAvailable",
      args: [parent.label],
    }),
    /* Unregistered names have no token, and `findTokenId` reverts rather than
       answering zero, so this is allowed to fail. The null it produces is what
       `registered: false` means further down. */
    client
      .readContract({
        address: deployment.ethRegistry,
        abi: registryAbi,
        functionName: "findTokenId",
        args: [parent.label],
      })
      .catch(() => null),
  ]);
  const registered = !available;

  if (registry === null) {
    /* No registry yet, so there is nothing to ask about roles ON it. The one
       question still worth answering is whether this account could create one,
       because that decides whether /connect offers the step or explains that
       somebody else has to take it. */
    const callerMaySetSubregistry =
      tokenId === null
        ? false
        : await client
            .readContract({
              address: deployment.ethRegistry,
              abi: registryAbi,
              functionName: "hasRoles",
              args: [tokenId, ROLE_SET_SUBREGISTRY, account],
            })
            .catch(() => false);

    return {
      parent,
      deployment,
      registered,
      registry: null,
      tokenId,
      callerMaySetSubregistry,
      parentLinked: false,
      connected: false,
      registrarGranted: false,
      resolverRolesGranted: false,
      open: false,
      callerIsAdmin: false,
      callerMayMint: false,
      resolver: zeroAddress,
      node: parent.node,
    };
  }

  const [readiness, stored, callerIsAdmin, linked, callerMaySetSubregistry] = await Promise.all([
    client.readContract({
      address: minter,
      abi: minterAbi,
      functionName: "readiness",
      args: [registry, account],
    }),
    client.readContract({
      address: minter,
      abi: minterAbi,
      functionName: "parentOf",
      args: [registry],
    }),
    client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "hasRoles",
      args: [0n, ROLE_REGISTRAR_ADMIN, account],
    }),
    /* The upward half of the link, read from the registry rather than inferred
       from the downward half. They are set by two different transactions to two
       different contracts and can disagree. */
    client
      .readContract({ address: registry, abi: registryAbi, functionName: "getParent" })
      .catch(() => null),
    tokenId === null
      ? Promise.resolve(false)
      : client
          .readContract({
            address: deployment.ethRegistry,
            abi: registryAbi,
            functionName: "hasRoles",
            args: [tokenId, ROLE_SET_SUBREGISTRY, account],
          })
          .catch(() => false),
  ]);

  /* Both fields have to match. A registry pointed at the right contract under
     the wrong label resolves upward to a name that is not this one. */
  const parentLinked =
    linked !== null &&
    linked[0].toLowerCase() === deployment.ethRegistry.toLowerCase() &&
    linked[1] === parent.label;

  const [connected, registrarGranted, resolverRolesGranted, open, callerMayMint] = readiness;
  const [, , resolver, node] = stored;

  return {
    parent,
    deployment,
    registered,
    registry,
    tokenId,
    callerMaySetSubregistry,
    parentLinked,
    connected,
    registrarGranted,
    resolverRolesGranted,
    open,
    callerIsAdmin,
    callerMayMint,
    resolver,
    node,
  };
}

/**
 * The one sentence to show for a parent that cannot be minted under, or null if
 * it can be.
 *
 * Ordered by what has to be fixed first, so a user following it top to bottom
 * never fixes something that turns out to be blocked by an earlier step.
 */
export function parentBlocker(status: ParentStatus): string | null {
  if (!status.registered) {
    return `nobody has registered ${status.parent.name} yet — it has to be bought before it can host agents`;
  }
  if (status.registry === null) {
    return `${status.parent.name} has no subregistry yet, so it cannot issue subnames to anyone`;
  }
  if (!status.parentLinked) {
    return `${status.parent.name}'s registry does not point back at the name, so records under it cannot be authorized`;
  }
  if (!status.connected) return `${status.parent.name} has not been connected to Capsule yet`;
  if (!status.registrarGranted) {
    return `Capsule cannot register subnames under ${status.parent.name} — the minter is missing ROLE_REGISTRAR on its registry`;
  }
  if (!status.resolverRolesGranted) {
    return `Capsule cannot write records under ${status.parent.name} — the minter is missing its root roles on the resolver`;
  }
  if (!status.callerMayMint) {
    return `${status.parent.name} is closed: only its own admins can mint here`;
  }
  return null;
}

/**
 * Whether a name has been fully wired and this account may use it.
 *
 * The launch form's gate, kept next to `parentBlocker` so the boolean and the
 * sentence explaining it can never disagree.
 */
export function parentIsReady(status: ParentStatus): boolean {
  return parentBlocker(status) === null;
}

/* ------------------------------------------------------------------ */
/* which names does this wallet actually have                          */
/* ------------------------------------------------------------------ */

/**
 * A parent this account has a real claim on, and why.
 *
 * "Has a claim on" is deliberately not "owns". Owning a name and being able to
 * host agents under it are different facts — `open` parents accept mints from
 * anyone — so this describes the two things that actually put a name on
 * somebody's dashboard: they connected it, or they have minted under it.
 */
export type OwnedParent = {
  name: string;
  node: Hex;
  registry: Address;
  /** Anyone may mint here, versus only this parent's own admins. */
  open: boolean;
  /** Capsules this account has minted under it. */
  minted: number;
  /** This account is the one that called `connectParent`. */
  connectedByOwner: boolean;
};

/**
 * A DNS wire name back into a readable one.
 *
 * `packetToBytes` above goes one way and viem ships no inverse, but the minter
 * stores `parentDns` at connect time and `parentOf` hands it back, which makes
 * it the only place a parent's *name* — not its hash — survives on chain. That
 * is the whole reason the fleet can be routed from chain state instead of from
 * a cookie: namehash is one-way, so without this the mint events would identify
 * a parent we could filter on but never name.
 *
 * Returns "" on anything malformed rather than throwing. The caller verifies the
 * result by namehashing it back to the node the contract reported, so a wrong
 * answer here becomes a dropped parent rather than a wrong dashboard.
 */
function decodeDnsName(dns: Hex): string {
  try {
    const bytes = hexToBytes(dns);
    const labels: string[] = [];
    let i = 0;
    while (i < bytes.length) {
      const length = bytes[i];
      if (length === 0) break;
      if (i + 1 + length > bytes.length) return "";
      labels.push(new TextDecoder().decode(bytes.slice(i + 1, i + 1 + length)));
      i += 1 + length;
    }
    return labels.join(".");
  } catch {
    return "";
  }
}

/**
 * Every parent this account can sensibly be shown, read from the chain.
 *
 * Exists because `CAPSULE_PARENT_NAME` is a deployment default, not an identity,
 * and a launchpad that serves one name per deployment is not a launchpad. The
 * alternative — remembering the last parent in `localStorage` — was rejected on
 * the grounds that it is per-browser and per-device, and that a project whose
 * central claim is "the chain is the database" should not route its own
 * dashboard from a cookie.
 *
 * Reverse resolution is not used, and would not work here: a primary name is one
 * name where a wallet may have several, says nothing about whether the minter is
 * wired to it, and is unset for almost everyone on a testnet. `ParentConnected`
 * and `CapsuleMinted` describe what someone has actually *done* with a name,
 * which is the question a fleet dashboard is asking.
 *
 * Three round trips regardless of how many parents exist.
 */
export async function readOwnerParents(
  client: PublicClient,
  config: { minter: Address; fromBlock: bigint; owner: Address },
): Promise<OwnedParent[]> {
  const { minter, fromBlock, owner } = config;

  const [connections, mints] = await Promise.all([
    client.getContractEvents({
      address: minter,
      abi: minterAbi,
      eventName: "ParentConnected",
      fromBlock,
      toBlock: "latest",
    }),
    client.getContractEvents({
      address: minter,
      abi: minterAbi,
      eventName: "CapsuleMinted",
      // `owner` is the third indexed field, so this is a topic filter the RPC
      // applies. Reading one wallet's names costs the same whether the minter has
      // served one of them or a thousand.
      args: { owner },
      fromBlock,
      toBlock: "latest",
    }),
  ]);

  if (connections.length === 0) return [];

  // Who connected each registry, newest wins — a parent can be disconnected and
  // reconnected, possibly by a different admin, and the current one is the claim.
  const connectedBy = new Map<Address, Address>();
  for (const log of [...connections].sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)))) {
    const registry = log.args.registry as Address | undefined;
    const by = log.args.by as Address | undefined;
    if (registry !== undefined && by !== undefined) connectedBy.set(registry, by);
  }

  // Capsules per parent, counted by distinct label so a name re-minted after
  // expiry is one agent and not two.
  const labelsByNode = new Map<Hex, Set<string>>();
  for (const log of mints) {
    const node = log.args.parentNode as Hex | undefined;
    const label = log.args.label as string | undefined;
    if (node === undefined || label === undefined) continue;
    const labels = labelsByNode.get(node) ?? new Set<string>();
    labels.add(label);
    labelsByNode.set(node, labels);
  }

  const registries = [...connectedBy.keys()];
  // `parentOf` rather than replaying `ParentDisconnected`: the contract already
  // tracks the current state, and a disconnect-then-reconnect sequence
  // reconstructed from events is a bug waiting to be written.
  const stored = await client.multicall({
    contracts: registries.map((registry) => ({
      address: minter,
      abi: minterAbi,
      functionName: "parentOf" as const,
      args: [registry] as const,
    })),
    allowFailure: true,
  });

  const parents: OwnedParent[] = [];
  stored.forEach((result, index) => {
    if (result.status !== "success") return;
    const [connected, open, , node, dnsName] = result.result as readonly [
      boolean,
      boolean,
      Address,
      Hex,
      Hex,
      boolean,
    ];
    if (!connected) return;

    const name = decodeDnsName(dnsName);
    // The integrity check that makes the decoder safe to trust. If the name we
    // decoded does not hash to the node the contract reported, we have misread
    // the wire format, and a parent silently dropped beats one whose dashboard
    // is addressed by a name that means something else.
    if (name === "" || namehash(name) !== node) return;

    const registry = registries[index];
    const minted = labelsByNode.get(node)?.size ?? 0;
    const connectedByOwner = connectedBy.get(registry)?.toLowerCase() === owner.toLowerCase();
    if (minted === 0 && !connectedByOwner) return;

    parents.push({ name, node, registry, open, minted, connectedByOwner });
  });

  // Where this wallet has the most at stake first: agents it minted, then names
  // it wired up but has not used yet.
  return parents.sort(
    (a, b) =>
      b.minted - a.minted ||
      Number(b.connectedByOwner) - Number(a.connectedByOwner) ||
      a.name.localeCompare(b.name),
  );
}

/** Re-exported so callers wiring the connect transactions need one import. */
export { ROLE_REGISTRAR, ROLE_REGISTRAR_ADMIN };
