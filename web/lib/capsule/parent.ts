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
import { zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { namehash, normalize, packetToBytes } from "viem/ens";
import { toHex } from "viem";
import {
  ETH_REGISTRY,
  ROLE_REGISTRAR,
  ROLE_REGISTRAR_ADMIN,
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
 * can mint anything under it — not this app, not the ENS manager. It is the one
 * setup step /connect cannot perform on the user's behalf, so it is reported
 * distinctly rather than folded into "not ready".
 */
export async function readParentRegistry(
  client: PublicClient,
  parent: ParentName,
): Promise<Address | null> {
  const registry = await client.readContract({
    address: ETH_REGISTRY,
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
  /** Null when the name has no subregistry — nothing else can be true yet. */
  registry: Address | null;
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
  const registry = await readParentRegistry(client, parent);

  if (registry === null) {
    return {
      parent,
      registry: null,
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

  const [readiness, stored, callerIsAdmin] = await Promise.all([
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
  ]);

  const [connected, registrarGranted, resolverRolesGranted, open, callerMayMint] = readiness;
  const [, , resolver, node] = stored;

  return {
    parent,
    registry,
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
  if (status.registry === null) {
    return `${status.parent.name} has no subregistry, so it cannot issue subnames to anyone yet — deploy one in the ENS manager first`;
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

/** Re-exported so callers wiring the connect transactions need one import. */
export { ROLE_REGISTRAR, ROLE_REGISTRAR_ADMIN };
