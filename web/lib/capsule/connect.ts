/**
 * Connecting a name to the minter, as the four calls a browser can make.
 *
 * Client-safe: no env, no node:crypto, no server RPC. Every transaction here is
 * signed by the name's own owner, and none of them is sent to Capsule — three
 * of the four go to ENS contracts the owner controls, and `connectParent` only
 * records what they already granted.
 *
 * ## What connecting actually is
 *
 * `CapsuleMinter` cannot mint under a name until three separate things are true,
 * and none of them is something Capsule can arrange for itself:
 *
 *   1. The name has a `PermissionedResolver` — `deployResolver`.
 *   2. The minter holds `ROLE_REGISTRAR` on the name's registry — `grantRegistrar`.
 *   3. The minter holds four root roles on that resolver — `grantResolverRoles`.
 *
 * and then one that is:
 *
 *   4. `connectParent` stores the resolver and the DNS name against the registry.
 *
 * That the minter cannot do 1–3 for itself is the security property, not an
 * inconvenience. Connecting is something an owner does TO Capsule, and revoking
 * either grant takes the capability back without Capsule's cooperation — the
 * same shape as the recall, one level up: there is no `disableCapsule()` we
 * could decline to honour.
 *
 * ## The step before all four: a subregistry
 *
 * A `.eth` name registered through the ENSv2 beta has no subregistry —
 * `getSubregistry` answers the zero address — and until it has one, nobody can
 * issue subnames under it by any means. The four calls above all presuppose it:
 * three of them are addressed *to* the registry, which does not exist yet.
 *
 * This was deliberately left to the ENS manager app for a while, on the theory
 * that a 31KB deployment plus a two-way link was ENS's primitive to get right
 * and not ours to reimplement. That turned out to be wrong on the facts. The
 * manager does not set a subregistry either — of a thousand `NameRegistered`
 * events on this deployment, zero carry one — so "go and do it there" was advice
 * that could not be followed, and a name bought through `/register` had nowhere
 * to go at all.
 *
 * So it is here, as `deploySubregistry` -> `attachSubregistry` ->
 * `linkSubregistryParent`. Three transactions rather than one because they are
 * addressed to three different contracts, and split rather than batched because
 * each one is separately resumable: the expensive step is the first, and a user
 * who lands on this page twice should pay for it once.
 *
 * Both halves of the link are required and neither implies the other. Setting
 * only the parent->child half leaves a registry that resolves downward and not
 * upward, which passes every obvious test and then fails resolver authorization
 * — the failure that cost this project a day (contracts/NOTES.md, gotcha 1).
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  keccak256,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { getCapabilities, sendCalls, waitForCallsStatus } from "viem/actions";
import {
  ALL_ROLES,
  ROLE_REGISTRAR,
  minterAbi,
  registryAbi,
  registryDeployAbi,
  resolverAdminAbi,
  resolverInitAbi,
  resolverInitAbiV2,
  userRegistryInitAbi,
  verifiableFactoryAbi,
  type DeploymentAddresses,
} from "./chain";
import { readParentStatus, type ParentName, type ParentStatus } from "./parent";

/* ------------------------------------------------------------------
   Grants, folded into the deployment that creates the thing granted on.

   Both `initialize` entry points on the hackathon deployment take a LIST of
   grants, and for a while this file passed a list of one. That cost two extra
   signatures for nothing: the roles the minter needs are known before the
   contract exists, so they can be handed over in the transaction that creates
   it. The owner still gets `ALL_ROLES` and can revoke the minter's at any time,
   which is the whole security property — it is unchanged, it just stops taking
   two round trips through a wallet popup to establish.

   The beta deployment cannot do this: its resolver's `initialize` takes one
   admin and one bitmap, and its registry is a constructor, not a proxy. So both
   builders report whether the minter was included, and the flow falls back to
   the explicit grant where it was not.
   ------------------------------------------------------------------ */

export type InitData = {
  data: Hex;
  /** The minter's roles are baked in; no follow-up grant transaction is needed. */
  grantsMinter: boolean;
};

/** `UserRegistry.initialize` — the hackathon deployment's subregistry proxy. */
export function userRegistryInitData(args: { owner: Address; minter?: Address }): InitData {
  const grants: { account: Address; roleBitmap: bigint }[] = [
    { account: args.owner, roleBitmap: ALL_ROLES },
  ];
  // `ROLE_REGISTRAR` is the only role the minter ever holds on a registry, and it
  // is root-scoped, which is what `readiness` reads back with `hasRoles(0, …)`.
  if (args.minter !== undefined) grants.push({ account: args.minter, roleBitmap: ROLE_REGISTRAR });
  return {
    data: encodeFunctionData({
      abi: userRegistryInitAbi,
      functionName: "initialize",
      args: [grants],
    }),
    grantsMinter: args.minter !== undefined,
  };
}

/**
 * `PermissionedResolver.initialize`, in whichever shape this deployment speaks.
 *
 * `resolverRoles` is `REQUIRED_RESOLVER_ROOT_ROLES` read off the minter — never a
 * constant copied into the frontend, for the same reason `grantResolverRoles`
 * reads it: a stale copy produces a grant that looks successful and a first mint
 * that reverts on the one role nobody carried across.
 */
export function resolverInitData(args: {
  admin: Address;
  minter?: Address;
  resolverRoles?: bigint;
  deployment: DeploymentAddresses;
}): InitData {
  if (!args.deployment.inodeResolver) {
    // One admin, one bitmap: no room for a second grantee.
    return {
      data: encodeFunctionData({
        abi: resolverInitAbi,
        functionName: "initialize",
        args: [args.admin, ALL_ROLES, []],
      }),
      grantsMinter: false,
    };
  }
  const grants: { account: Address; roleBitmap: bigint }[] = [
    { account: args.admin, roleBitmap: ALL_ROLES },
  ];
  const withMinter = args.minter !== undefined && args.resolverRoles !== undefined;
  if (withMinter) {
    grants.push({ account: args.minter as Address, roleBitmap: args.resolverRoles as bigint });
  }
  return {
    data: encodeFunctionData({
      abi: resolverInitAbiV2,
      functionName: "initialize",
      args: [grants, []],
    }),
    grantsMinter: withMinter,
  };
}

/** `REQUIRED_RESOLVER_ROOT_ROLES`, from the minter rather than from a constant. */
export async function readRequiredResolverRoles(
  publicClient: PublicClient,
  minter: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: minter,
    abi: minterAbi,
    functionName: "REQUIRED_RESOLVER_ROOT_ROLES",
  });
}

/**
 * Whether the minter already holds its four root roles on `resolver`.
 *
 * Asked of the resolver directly, because `readiness` cannot answer it before
 * `connectParent` — that field reads `parent.resolver`, which is the zero address
 * until a parent is connected, so a resolver deployed with the grants baked in
 * looks ungranted right up until the last step. The minter's own view function is
 * the authority, so the check and the requirement cannot drift apart.
 */
export async function minterHasResolverRoles(
  publicClient: PublicClient,
  minter: Address,
  resolver: Address,
): Promise<boolean> {
  try {
    await publicClient.readContract({
      address: minter,
      abi: minterAbi,
      functionName: "checkResolverRoles",
      args: [resolver],
    });
    return true;
  } catch {
    return false;
  }
}

export class ConnectError extends Error {
  /** `"rejected"` when the user dismissed the wallet: not worth a red banner. */
  readonly kind: "rejected" | "reverted" | "failed";
  constructor(kind: ConnectError["kind"], message: string) {
    super(message);
    this.name = "ConnectError";
    this.kind = kind;
  }
}

/** Maps a revert to the sentence that explains it. */
function revertMessage(name: string): string {
  switch (name) {
    case "NotParentAdmin":
      return "this wallet does not administer that name's registry — connect with the wallet that deployed it";
    case "ParentLinkBroken":
      return "that registry is not wired to this name on chain: ENS has to agree in both directions, and it does not";
    case "ParentNotConnected":
      return "this name is not connected to Capsule yet";
    case "InvalidName":
      return "the name could not be decoded — this is a bug in Capsule, not in your name";
    case "EACUnauthorizedAccountRoles":
    case "EACCannotRevokeRoles":
      return "this wallet is not allowed to grant roles there";
    case "NameExpired":
      return "that name's registration has expired — renew it before connecting it";
    case "InvalidSubregistry":
      return "ENS rejected that registry — it is not a registry this name may point at";
    default:
      return `the transaction reverted with ${name}`;
  }
}

function explain(error: unknown): ConnectError {
  if (error instanceof BaseError) {
    const code = (error.walk() as { code?: number }).code;
    if (code === 4001 || /user (rejected|denied)/i.test(error.shortMessage ?? "")) {
      return new ConnectError("rejected", "Signature rejected in the wallet.");
    }
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name !== undefined) return new ConnectError("reverted", revertMessage(name));
      return new ConnectError("reverted", "the transaction reverted");
    }
    return new ConnectError("failed", error.shortMessage ?? error.message);
  }
  return new ConnectError("failed", error instanceof Error ? error.message : "the transaction failed");
}

export type ConnectStep = "simulating" | "signing" | "mining";
export type OnPhase = (phase: ConnectStep, detail?: string) => void;

type SendArgs = {
  walletClient: WalletClient;
  publicClient: PublicClient;
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
};

/**
 * Simulate, sign, wait — the same three phases as the mint, for the same reason.
 *
 * `eth_call` costs nothing and answers exactly the question a failed transaction
 * answers expensively. Every call in this file goes through it, so a wallet that
 * is not the name's admin finds out before it opens a popup rather than after
 * paying for a revert.
 */
async function send(args: SendArgs, onPhase?: OnPhase): Promise<{ hash: Hex; logs: unknown[] }> {
  const { walletClient, publicClient, address, abi, functionName, args: callArgs } = args;
  const account = walletClient.account;
  if (account === undefined) throw new ConnectError("failed", "the wallet client has no account");

  onPhase?.("simulating");
  let request;
  try {
    ({ request } = await publicClient.simulateContract({
      address,
      abi: abi as never,
      functionName,
      args: callArgs as never,
      account: account.address,
    }));
  } catch (error) {
    throw explain(error);
  }

  onPhase?.("signing");
  let hash: Hex;
  try {
    hash = await walletClient.writeContract(request as never);
  } catch (error) {
    throw explain(error);
  }

  onPhase?.("mining", hash);
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash });
  } catch (error) {
    throw explain(error);
  }
  if (receipt.status !== "success") {
    throw new ConnectError("reverted", "the transaction was mined but reverted");
  }
  return { hash, logs: receipt.logs };
}

/**
 * Deploys a `PermissionedRegistry` the caller owns outright.
 *
 * The first of the three transactions that give a name a subregistry, and the
 * only expensive one: 31KB of creation code, a little over five million gas.
 *
 * The bytecode is `await import`ed rather than imported at the top of the file
 * so that it lands in its own chunk. Every page that touches /connect imports
 * this module; only the handful of users whose name has no subregistry ever
 * deploy one, and the rest should not download 62KB of hex to find that out.
 *
 * `rootAccount` is the caller and the role bitmap is `ALL_ROLES`, which means
 * the registry answers to its owner and to nobody else — Capsule included. The
 * minter gets `ROLE_REGISTRAR` on it afterwards, in `grantRegistrar`, as a
 * separate signature. Deploying it through this app therefore grants Capsule
 * nothing; it is the user's registry from the moment it exists, and it stays
 * theirs if they never finish connecting.
 */
export async function deploySubregistry(
  args: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    owner: Address;
    deployment: DeploymentAddresses;
    /**
     * Granted `ROLE_REGISTRAR` as the registry is created, where the deployment
     * allows it — which removes `grantRegistrar` from the flow entirely. Omit it
     * and the registry answers to its owner and nobody else, exactly as before.
     */
    minter?: Address;
  },
  onPhase?: OnPhase,
): Promise<{ hash: Hex; registry: Address; grantsMinter: boolean }> {
  const account = args.walletClient.account;
  if (account === undefined) throw new ConnectError("failed", "the wallet client has no account");

  // The hackathon deployment has a `UserRegistry` implementation, so a
  // subregistry there is a proxy rather than a whole contract: one `deployProxy`
  // instead of five million gas of creation code, and the 31KB bytecode chunk
  // never loads. The beta has no such implementation, which is the only reason
  // that constant exists at all.
  if (args.deployment.userRegistryImpl !== undefined) {
    const init = userRegistryInitData({ owner: args.owner, minter: args.minter });
    const { hash, resolver: registry } = await deployProxyVia(
      {
        walletClient: args.walletClient,
        publicClient: args.publicClient,
        deployment: args.deployment,
        implementation: args.deployment.userRegistryImpl,
        salt: REGISTRY_SALT,
        initData: init.data,
      },
      onPhase,
    );
    return { hash, registry, grantsMinter: init.grantsMinter };
  }

  onPhase?.("simulating");
  const { PERMISSIONED_REGISTRY_BYTECODE } = await import("./registry-bytecode");

  onPhase?.("signing");
  let hash: Hex;
  try {
    hash = await args.walletClient.deployContract({
      abi: registryDeployAbi,
      bytecode: PERMISSIONED_REGISTRY_BYTECODE,
      args: [args.deployment.labelStore, args.owner, ALL_ROLES],
      account,
      chain: args.walletClient.chain,
    } as never);
  } catch (error) {
    throw explain(error);
  }

  onPhase?.("mining", hash);
  let receipt;
  try {
    receipt = await args.publicClient.waitForTransactionReceipt({ hash });
  } catch (error) {
    throw explain(error);
  }
  if (receipt.status !== "success") {
    throw new ConnectError("reverted", "the registry deployment was mined but reverted");
  }
  /* `contractAddress` comes off the receipt rather than from a CREATE address
     computed here. A deployment is the one case where the address is a fact the
     chain reports, and deriving it from (sender, nonce) instead would be a
     second implementation that can disagree with the first. */
  const registry = receipt.contractAddress;
  if (registry === null || registry === undefined) {
    throw new ConnectError("failed", "the deployment succeeded but produced no contract address");
  }
  /* The vendored-bytecode path takes `(labelStore, rootAccount, roleBitmap)` — one
     account — so the minter's grant cannot ride along and `grantRegistrar` is
     still a separate signature here. */
  return { hash, registry, grantsMinter: false };
}

/**
 * Points the name at the registry: the parent -> child half of the link.
 *
 * Sent to `ETH_REGISTRY` against the name's own token id, which is why it needs
 * `tokenId` and not the label — `setSubregistry` is a role-gated write on the
 * ERC-1155 token, and the role the registrar granted the owner at registration
 * is scoped to exactly that id.
 */
export async function attachSubregistry(
  args: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    tokenId: bigint;
    registry: Address;
    deployment: DeploymentAddresses;
  },
  onPhase?: OnPhase,
): Promise<Hex> {
  const { hash } = await send(
    {
      walletClient: args.walletClient,
      publicClient: args.publicClient,
      address: args.deployment.ethRegistry,
      abi: registryAbi,
      functionName: "setSubregistry",
      args: [args.tokenId, args.registry],
    },
    onPhase,
  );
  return hash;
}

/**
 * Tells the registry which name it belongs to: the child -> parent half.
 *
 * Easy to skip, because everything visible works without it. Names resolve
 * downward from a registry that has never been told its parent; what fails is
 * resolving *upward*, and resolver authorization is upward — `findCanonicalName`
 * returns an empty string the moment it meets a registry whose parent is zero,
 * and every record write under the name reverts for a reason that names the
 * wrong thing.
 *
 * So this is not a tidying step to be folded into the previous one. It is half
 * of the link, and /connect reads both halves back before it calls a name wired.
 */
export async function linkSubregistryParent(
  args: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    registry: Address;
    label: string;
    deployment: DeploymentAddresses;
  },
  onPhase?: OnPhase,
): Promise<Hex> {
  const { hash } = await send(
    {
      walletClient: args.walletClient,
      publicClient: args.publicClient,
      address: args.registry,
      abi: registryAbi,
      functionName: "setParent",
      args: [args.deployment.ethRegistry, args.label],
    },
    onPhase,
  );
  return hash;
}

/**
 * Deploys a `PermissionedResolver` proxy owned by the caller.
 *
 * The salt is fixed rather than random, and that is the interesting decision.
 * `VerifiableFactory` derives the CREATE2 address from
 * `keccak256(deployer, salt)`, so one wallet with this salt always lands on the
 * same address — which means a connect that was abandoned after this step and
 * resumed an hour later reuses the resolver it already paid for instead of
 * stranding it and deploying another. The cost is that a second resolver for the
 * same wallet needs a different salt, which nothing in this flow wants.
 *
 * `initialize(admin, ALL_ROLES, [])` makes the caller the resolver's root admin.
 * The minter gets its four roles in a separate transaction the owner also signs,
 * so at no point does Capsule hold anything the owner did not hand over
 * explicitly.
 */
export const RESOLVER_SALT = 0n;

/**
 * The registry's salt, and it MUST differ from the resolver's.
 *
 * `VerifiableFactory` derives the proxy address from `(factory, deployer, salt)`
 * and ignores the implementation entirely, so deploying a registry and a
 * resolver from one wallet under the same salt is a CREATE2 collision — the
 * second transaction reverts with no reason data, which reads like a broken
 * contract rather than a reused number.
 */
export const REGISTRY_SALT = 1n;

async function deployProxyVia(
  args: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    deployment: DeploymentAddresses;
    implementation: Address;
    salt: bigint;
    initData: Hex;
  },
  onPhase?: OnPhase,
): Promise<{ hash: Hex; resolver: Address }> {
  const factory = args.deployment.verifiableFactory;
  const { hash, logs } = await send(
    {
      walletClient: args.walletClient,
      publicClient: args.publicClient,
      address: factory,
      abi: verifiableFactoryAbi,
      functionName: "deployProxy",
      args: [args.implementation, args.salt, args.initData],
    },
    onPhase,
  );

  // Read from the event, not from the simulation's return value. The address is
  // deterministic and the simulation would answer correctly — but a value read
  // off the mined receipt is the one that exists, and a deploy that emitted no
  // ProxyDeployed is not a contract whatever the return data said.
  const events = parseEventLogs({
    abi: verifiableFactoryAbi,
    eventName: "ProxyDeployed",
    logs: logs as never,
  });
  const event = events.find((e) => e.address.toLowerCase() === factory.toLowerCase());
  if (event === undefined) {
    throw new ConnectError("failed", "the transaction succeeded but emitted no ProxyDeployed event");
  }
  return { hash, resolver: event.args.proxyAddress };
}

export async function deployResolver(
  args: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    admin: Address;
    deployment: DeploymentAddresses;
    /**
     * Granted `REQUIRED_RESOLVER_ROOT_ROLES` during initialization where the
     * deployment's `initialize` takes a list of grants, which removes
     * `grantResolverRoles` from the flow. The roles are read off the minter here
     * rather than passed in, so a caller cannot supply a stale bitmap.
     */
    minter?: Address;
  },
  onPhase?: OnPhase,
): Promise<{ hash: Hex; resolver: Address; grantsMinter: boolean }> {
  // The two deployments disagree on `initialize`: the beta takes one admin and
  // one bitmap, the hackathon revision takes a list of grants and a list of
  // calls to multicall during initialization. Only the second can carry the
  // minter's roles, so only there is the grant folded in.
  const resolverRoles =
    args.minter !== undefined && args.deployment.inodeResolver
      ? await readRequiredResolverRoles(args.publicClient, args.minter)
      : undefined;
  const init = resolverInitData({
    admin: args.admin,
    minter: args.minter,
    resolverRoles,
    deployment: args.deployment,
  });

  const { hash, resolver } = await deployProxyVia(
    {
      walletClient: args.walletClient,
      publicClient: args.publicClient,
      deployment: args.deployment,
      implementation: args.deployment.permissionedResolverImpl,
      salt: RESOLVER_SALT,
      initData: init.data,
    },
    onPhase,
  );
  return { hash, resolver, grantsMinter: init.grantsMinter };
}

/** Grants the minter `ROLE_REGISTRAR` on the parent's registry. */
export async function grantRegistrar(
  args: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    registry: Address;
    minter: Address;
  },
  onPhase?: OnPhase,
): Promise<Hex> {
  const { hash } = await send(
    {
      walletClient: args.walletClient,
      publicClient: args.publicClient,
      address: args.registry,
      abi: registryAbi,
      functionName: "grantRootRoles",
      args: [ROLE_REGISTRAR, args.minter],
    },
    onPhase,
  );
  return hash;
}

/**
 * Grants the minter the four root roles it writes records with.
 *
 * The bitmap is read off the minter rather than spelled here. It is one constant
 * in one contract, and a second copy in the frontend would be a second thing to
 * keep in step — with the failure mode that a grant looks successful and the
 * first mint reverts on the one role nobody copied across.
 */
export async function grantResolverRoles(
  args: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    resolver: Address;
    minter: Address;
  },
  onPhase?: OnPhase,
): Promise<Hex> {
  const roles = await args.publicClient.readContract({
    address: args.minter,
    abi: minterAbi,
    functionName: "REQUIRED_RESOLVER_ROOT_ROLES",
  });

  const { hash } = await send(
    {
      walletClient: args.walletClient,
      publicClient: args.publicClient,
      address: args.resolver,
      abi: resolverAdminAbi,
      functionName: "grantRootRoles",
      args: [roles, args.minter],
    },
    onPhase,
  );
  return hash;
}

/**
 * Records the parent with the minter.
 *
 * The last step, and the only one sent to a Capsule contract. It verifies the
 * two-way registry link on chain before storing anything, so a name whose
 * subregistry is wired in one direction only fails here with `ParentLinkBroken`
 * rather than minting into a registry that nothing resolves through.
 */
export async function connectParent(
  args: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    minter: Address;
    registry: Address;
    resolver: Address;
    parent: ParentName;
    open: boolean;
  },
  onPhase?: OnPhase,
): Promise<Hex> {
  const { hash } = await send(
    {
      walletClient: args.walletClient,
      publicClient: args.publicClient,
      address: args.minter,
      abi: minterAbi,
      functionName: "connectParent",
      args: [args.registry, args.resolver, args.parent.dnsName, args.open],
    },
    onPhase,
  );
  return hash;
}

/** Flips whether strangers may mint under an already-connected name. */
export async function setParentOpen(
  args: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    minter: Address;
    registry: Address;
    open: boolean;
  },
  onPhase?: OnPhase,
): Promise<Hex> {
  const { hash } = await send(
    {
      walletClient: args.walletClient,
      publicClient: args.publicClient,
      address: args.minter,
      abi: minterAbi,
      functionName: "setParentOpen",
      args: [args.registry, args.open],
    },
    onPhase,
  );
  return hash;
}

/* ==================================================================
   One click, and where possible one popup.

   Everything above is a single transaction that makes a single on-chain fact
   true, and that is still the unit /connect displays. What was missing was
   something to run them: the page listed six buttons in the order the chain
   requires and left the ordering to the person least equipped to get it right.

   Two layers go on top of them here.

   `runConnect` is the loop — it reads the parent's status, does the first thing
   that is missing, reads it again, and repeats. Re-reading between every step
   rather than trusting a plan made at the start is what makes it safe to run
   against a half-finished connect: the loop cannot deploy a second resolver
   because it never remembers that it deployed the first, it asks.

   `planConnect` + `sendConnectCalls` are the fast path. A wallet that speaks
   EIP-5792 can take the whole remaining sequence as one batch and ask for one
   confirmation, and on wallets that batch atomically the half-linked subregistry
   state stops being reachable at all. The reason it is possible is that nothing
   in the sequence needs an address that only exists after a transaction has been
   mined: both deployments go through `VerifiableFactory`, whose CREATE2 address
   is a pure function of (factory, deployer, salt), so call 2 can reference the
   contract call 1 is about to create.
   ================================================================== */

/**
 * EIP-1167 clone creation code, byte for byte as `CloneProxyBytecode` builds it.
 *
 * The 32-byte salt appended after the 45-byte runtime is what makes the proxy
 * verifiable — `UUPSProxyLogic` reads it back with `extcodecopy` — and it is part
 * of the creation code, so it has to be part of the hash this predicts from.
 */
const CLONE_PREFIX = "0x3d604d80600a3d3981f3363d3d373d3d3d363d73" as const;
const CLONE_SUFFIX = "0x5af43d82803e903d91602b57fd5bf3" as const;

/**
 * Where `VerifiableFactory.deployProxy` will put a proxy, before it is called.
 *
 * `outerSalt = keccak256(abi.encode(deployer, salt))` is the factory's own
 * derivation, which is why two wallets can use the same salt without colliding —
 * and why this has to be told who the deployer will be. In a 5792 batch that is
 * the connected account, the same account that would send the transaction on its
 * own, so the predicted address matches whichever path runs.
 */
export function predictProxyAddress(args: {
  factory: Address;
  proxyLogic: Address;
  deployer: Address;
  salt: bigint;
}): Address {
  const outerSalt = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [args.deployer, args.salt],
    ),
  );
  const creationCode = concatHex([
    CLONE_PREFIX,
    args.proxyLogic.toLowerCase() as Hex,
    CLONE_SUFFIX,
    outerSalt,
  ]);
  return getCreate2Address({ from: args.factory, salt: outerSalt, bytecode: creationCode });
}

/** The shared logic contract every proxy clones. One read, cached per factory. */
const proxyLogicCache = new Map<Address, Address>();
export async function readProxyLogic(
  publicClient: PublicClient,
  deployment: DeploymentAddresses,
): Promise<Address> {
  const cached = proxyLogicCache.get(deployment.verifiableFactory);
  if (cached !== undefined) return cached;
  const logic = await publicClient.readContract({
    address: deployment.verifiableFactory,
    abi: verifiableFactoryAbi,
    functionName: "proxyLogic",
  });
  proxyLogicCache.set(deployment.verifiableFactory, logic);
  return logic;
}

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * A proxy this wallet has already paid for at the address it would get again.
 *
 * The salts are fixed, so `deployProxy` from the same wallet always lands on the
 * same address — which means a second deploy is not a waste, it is a CREATE2
 * collision: the opcode returns zero and the factory reverts with no reason data,
 * which reads as a broken contract rather than "you already have one of these".
 *
 * That used to be survivable because the page asked the user to paste the address
 * from their wallet history. It is not survivable for a button that runs the whole
 * sequence unattended, so the sequence looks first. A contract at the predicted
 * address is, by construction, the one this flow would have deployed.
 */
export async function findExistingProxy(args: {
  publicClient: PublicClient;
  deployment: DeploymentAddresses;
  deployer: Address;
  salt: bigint;
}): Promise<Address | null> {
  const predicted = predictProxyAddress({
    factory: args.deployment.verifiableFactory,
    proxyLogic: await readProxyLogic(args.publicClient, args.deployment),
    deployer: args.deployer,
    salt: args.salt,
  });
  const code = await args.publicClient.getCode({ address: predicted });
  return code === undefined || code === "0x" ? null : predicted;
}

/** Whether the minter holds `ROLE_REGISTRAR` on a registry, read off the registry. */
export async function registryGrantsRegistrar(
  publicClient: PublicClient,
  registry: Address,
  minter: Address,
): Promise<boolean> {
  return publicClient
    .readContract({
      address: registry,
      abi: registryAbi,
      functionName: "hasRoles",
      args: [0n, ROLE_REGISTRAR, minter],
    })
    .catch(() => false);
}

/** One call in a batch, with the sentence to show while it is in flight. */
export type ConnectCall = { to: Address; data: Hex; label: string };

export type ConnectPlan = {
  calls: ConnectCall[];
  /** The registry the plan ends at — predicted if the plan deploys it. */
  registry: Address | null;
  /** The resolver the plan ends at — predicted if the plan deploys it. */
  resolver: Address | null;
  /**
   * False when some step in the plan cannot be expressed as a call to an address,
   * which on the beta deployment means the raw registry deployment: EIP-5792
   * carries calls, not contract creations. The sequential path handles it.
   */
  batchable: boolean;
};

/**
 * The remaining steps for one parent, as calls, read off the chain.
 *
 * Derived from a `ParentStatus` rather than from what this session has done, so a
 * connect resumed after a reload plans only what is actually missing. The order
 * is the order the chain requires and is load-bearing: `setSubregistry` before
 * `setParent` (the other way round strands a registry pointing at a name that has
 * never heard of it), and `connectParent` last, because it verifies both halves
 * of the link on chain before it stores anything.
 */
export async function planConnect(args: {
  publicClient: PublicClient;
  status: ParentStatus;
  owner: Address;
  minter: Address;
  open: boolean;
  /** A registry or resolver this session already deployed, or the user pasted. */
  knownRegistry?: Address | null;
  knownResolver?: Address | null;
}): Promise<ConnectPlan> {
  const { status, owner, minter } = args;
  const deployment = status.deployment;
  const calls: ConnectCall[] = [];
  let batchable = true;

  /* ---- the registry ---- */
  let registry =
    status.registry ??
    args.knownRegistry ??
    (await findExistingProxy({
      publicClient: args.publicClient,
      deployment,
      deployer: owner,
      salt: REGISTRY_SALT,
    }));
  let registryGrantsMinter = false;
  if (registry === null) {
    if (deployment.userRegistryImpl === undefined) {
      // A 31KB CREATE deployment. Not a call, so not batchable.
      batchable = false;
    } else {
      const init = userRegistryInitData({ owner, minter });
      registry = predictProxyAddress({
        factory: deployment.verifiableFactory,
        proxyLogic: await readProxyLogic(args.publicClient, deployment),
        deployer: owner,
        salt: REGISTRY_SALT,
      });
      registryGrantsMinter = init.grantsMinter;
      calls.push({
        to: deployment.verifiableFactory,
        data: encodeFunctionData({
          abi: verifiableFactoryAbi,
          functionName: "deployProxy",
          args: [deployment.userRegistryImpl, REGISTRY_SALT, init.data],
        }),
        label: "Deploying your subregistry",
      });
    }
  }

  if (registry !== null) {
    if (status.registry === null && status.tokenId !== null) {
      calls.push({
        to: deployment.ethRegistry,
        data: encodeFunctionData({
          abi: registryAbi,
          functionName: "setSubregistry",
          args: [status.tokenId, registry],
        }),
        label: "Pointing your name at it",
      });
    }
    if (!status.parentLinked) {
      calls.push({
        to: registry,
        data: encodeFunctionData({
          abi: registryAbi,
          functionName: "setParent",
          args: [deployment.ethRegistry, status.parent.label],
        }),
        label: "Pointing it back at your name",
      });
    }
    /* Only for a registry that already existed. One deployed by this plan carries
       the grant in its `initialize`, and asking again would be a wasted signature.

       `status.registrarGranted` is only meaningful for a registry ENS already
       points at; for one this wallet deployed and never attached, the registry is
       the thing to ask. */
    const registrarGranted =
      status.registry !== null
        ? status.registrarGranted
        : await registryGrantsRegistrar(args.publicClient, registry, minter);
    if (!registryGrantsMinter && !registrarGranted) {
      calls.push({
        to: registry,
        data: encodeFunctionData({
          abi: registryAbi,
          functionName: "grantRootRoles",
          args: [ROLE_REGISTRAR, minter],
        }),
        label: "Letting Capsule register subnames",
      });
    }
  }

  /* ---- the resolver ---- */
  let resolver =
    (status.connected && status.resolver !== ZERO ? status.resolver : null) ??
    args.knownResolver ??
    (await findExistingProxy({
      publicClient: args.publicClient,
      deployment,
      deployer: owner,
      salt: RESOLVER_SALT,
    }));
  let resolverGrantsMinter = false;
  if (resolver === null) {
    const resolverRoles = deployment.inodeResolver
      ? await readRequiredResolverRoles(args.publicClient, minter)
      : undefined;
    const init = resolverInitData({ admin: owner, minter, resolverRoles, deployment });
    resolver = predictProxyAddress({
      factory: deployment.verifiableFactory,
      proxyLogic: await readProxyLogic(args.publicClient, deployment),
      deployer: owner,
      salt: RESOLVER_SALT,
    });
    resolverGrantsMinter = init.grantsMinter;
    calls.push({
      to: deployment.verifiableFactory,
      data: encodeFunctionData({
        abi: verifiableFactoryAbi,
        functionName: "deployProxy",
        args: [deployment.permissionedResolverImpl, RESOLVER_SALT, init.data],
      }),
      label: "Deploying your resolver",
    });
  }

  if (!resolverGrantsMinter && !(await minterHasResolverRoles(args.publicClient, minter, resolver))) {
    calls.push({
      to: resolver,
      data: encodeFunctionData({
        abi: resolverAdminAbi,
        functionName: "grantRootRoles",
        args: [await readRequiredResolverRoles(args.publicClient, minter), minter],
      }),
      label: "Letting Capsule write records",
    });
  }

  /* ---- record it with the minter ---- */
  if (!status.connected) {
    calls.push({
      to: minter,
      data: encodeFunctionData({
        abi: minterAbi,
        functionName: "connectParent",
        args: [registry as Address, resolver, status.parent.dnsName, args.open],
      }),
      label: "Registering the name with Capsule",
    });
  }

  return { calls, registry, resolver, batchable };
}

/**
 * Whether this wallet will take the whole sequence under one confirmation.
 *
 * `atomic: "supported"` is a wallet that already executes a batch as one
 * transaction; `"ready"` is one that will upgrade the account (EIP-7702) to do
 * so when asked. Both are worth batching into. Anything else — including every
 * wallet that has never heard of `wallet_getCapabilities` — answers false and
 * gets the sequential path, which is the same steps with more popups.
 */
export async function supportsBatching(
  walletClient: WalletClient,
  account: Address,
  chainId: number,
): Promise<boolean> {
  try {
    const capabilities = await getCapabilities(walletClient as never, { account, chainId });
    const atomic = (capabilities as { atomic?: { status?: string } }).atomic?.status;
    return atomic === "supported" || atomic === "ready";
  } catch {
    return false;
  }
}

/**
 * Sends a plan as one `wallet_sendCalls` batch and waits for it to land.
 *
 * No per-call simulation, which is the one thing lost by batching: there is no
 * `eth_call` that answers "would these five calls succeed in sequence", because
 * four of them act on state the first one creates. The trade is deliberate — a
 * batch that fails is reported, the page re-reads the chain, and the caller falls
 * back to the sequential path, where every call is simulated and a revert arrives
 * as the sentence that explains it.
 */
export async function sendConnectCalls(
  args: { walletClient: WalletClient; publicClient: PublicClient; account: Address; plan: ConnectPlan },
  onPhase?: OnPhase,
): Promise<Hex[]> {
  onPhase?.("signing");
  let id: string;
  try {
    const result = await sendCalls(args.walletClient as never, {
      account: args.account,
      chain: args.walletClient.chain,
      calls: args.plan.calls.map(({ to, data }) => ({ to, data })),
    } as never);
    id = result.id;
  } catch (error) {
    throw explain(error);
  }

  onPhase?.("mining");
  const status = await waitForCallsStatus(args.walletClient as never, { id, timeout: 180_000 });
  if (status.status !== "success") {
    throw new ConnectError(
      "reverted",
      status.status === "pending"
        ? "the wallet is still working through the batch — reload the page to see where it got to"
        : "the batch did not go through; retrying one step at a time will say why",
    );
  }
  return status.receipts?.map((receipt) => receipt.transactionHash) ?? [];
}

/** What `runConnect` reports as it goes, one entry per step it takes. */
export type ConnectReport = (event: {
  /** The sentence to show while this is happening. */
  step: string;
  phase?: ConnectStep;
  detail?: string;
  /** Set when the step finished: what is now true, and the transaction that did it. */
  done?: string;
  tx?: Hex;
}) => void;

/**
 * Connects a name, start to finish, from wherever it currently is.
 *
 * The page's one button. It does not hold a plan: it reads the parent's status,
 * takes the single next step that status says is missing, and reads again — so an
 * interrupted run resumes correctly, a step someone else completed is skipped,
 * and a step that silently failed stops the loop rather than being built on.
 *
 * Returns the final status, which is the same thing the page would have read for
 * itself. Throws `ConnectError` with `kind: "rejected"` when the wallet was
 * dismissed, which is not an error worth a banner — the user simply stopped.
 */
export async function runConnect(
  args: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    account: Address;
    minter: Address;
    parent: ParentName;
    open: boolean;
    knownRegistry?: Address | null;
    knownResolver?: Address | null;
    /** Fires the moment a deployment's address is known, so the page can keep it. */
    onRegistry?: (registry: Address) => void;
    onResolver?: (resolver: Address) => void;
    /** Set false to force the one-transaction-at-a-time path. */
    allowBatch?: boolean;
  },
  report?: ConnectReport,
): Promise<ParentStatus> {
  const { walletClient, publicClient, account, minter, parent } = args;
  let knownRegistry = args.knownRegistry ?? null;
  let knownResolver = args.knownResolver ?? null;

  const read = () => readParentStatus(publicClient, minter, parent, account);
  let status = await read();

  /* ---- the fast path: one confirmation for everything that is left ---- */
  if (args.allowBatch !== false) {
    const plan = await planConnect({
      publicClient,
      status,
      owner: account,
      minter,
      open: args.open,
      knownRegistry,
      knownResolver,
    });
    const chainId = walletClient.chain?.id;
    if (
      plan.batchable &&
      plan.calls.length > 1 &&
      chainId !== undefined &&
      (await supportsBatching(walletClient, account, chainId))
    ) {
      const step = `Connecting ${parent.name} · ${plan.calls.length} steps, one signature`;
      report?.({ step });
      if (plan.registry !== null) args.onRegistry?.(plan.registry);
      if (plan.resolver !== null) args.onResolver?.(plan.resolver);
      const hashes = await sendConnectCalls(
        { walletClient, publicClient, account, plan },
        (phase, detail) => report?.({ step, phase, detail }),
      );
      report?.({
        step,
        done: `${parent.name} is connected — ${plan.calls.length} calls in one batch`,
        tx: hashes[hashes.length - 1],
      });
      return read();
    }
  }

  /* ---- the sequential path: the same steps, one signature each ---- */
  const sub = (step: string) => (phase: ConnectStep, detail?: string) =>
    report?.({ step, phase, detail });

  /* Bounded rather than `while (true)`: every iteration either takes a step or
     stops, so the bound is only ever reached if a transaction succeeded without
     changing the fact it was sent to change. Looping forever on that would be a
     wallet popup every few seconds with no way out. */
  for (let round = 0; round < 8; round += 1) {
    const registry =
      status.registry ??
      knownRegistry ??
      (await findExistingProxy({
        publicClient,
        deployment: status.deployment,
        deployer: account,
        salt: REGISTRY_SALT,
      }));

    if (registry === null) {
      if (!status.registered) {
        throw new ConnectError("failed", `nobody has registered ${parent.name} yet`);
      }
      if (!status.callerMaySetSubregistry) {
        throw new ConnectError(
          "failed",
          `this wallet cannot give ${parent.name} a subregistry — connect with the wallet that registered it`,
        );
      }
      const step = "Deploying your subregistry";
      report?.({ step });
      const deployed = await deploySubregistry(
        { walletClient, publicClient, owner: account, deployment: status.deployment, minter },
        sub(step),
      );
      knownRegistry = deployed.registry;
      args.onRegistry?.(deployed.registry);
      report?.({ step, done: `subregistry deployed at ${deployed.registry}`, tx: deployed.hash });
      continue;
    }

    if (status.registry === null) {
      if (status.tokenId === null) {
        throw new ConnectError("failed", "this name has no token id on ENS — re-check it and try again");
      }
      const step = "Pointing your name at it";
      report?.({ step });
      const hash = await attachSubregistry(
        {
          walletClient,
          publicClient,
          tokenId: status.tokenId,
          registry,
          deployment: status.deployment,
        },
        sub(step),
      );
      report?.({ step, done: `${parent.name} now has a subregistry`, tx: hash });
      status = await read();
      continue;
    }

    if (!status.parentLinked) {
      const step = "Pointing it back at your name";
      report?.({ step });
      const hash = await linkSubregistryParent(
        { walletClient, publicClient, registry, label: parent.label, deployment: status.deployment },
        sub(step),
      );
      report?.({ step, done: `${parent.name} can now issue subnames`, tx: hash });
      status = await read();
      continue;
    }

    if (knownResolver === null) {
      const existing =
        (status.connected && status.resolver !== ZERO ? status.resolver : null) ??
        (await findExistingProxy({
          publicClient,
          deployment: status.deployment,
          deployer: account,
          salt: RESOLVER_SALT,
        }));
      if (existing !== null) {
        knownResolver = existing;
        args.onResolver?.(existing);
        continue;
      }
      const step = "Deploying your resolver";
      report?.({ step });
      const deployed = await deployResolver(
        { walletClient, publicClient, admin: account, deployment: status.deployment, minter },
        sub(step),
      );
      knownResolver = deployed.resolver;
      args.onResolver?.(deployed.resolver);
      report?.({ step, done: `resolver deployed at ${deployed.resolver}`, tx: deployed.hash });
      continue;
    }

    if (!(await registryGrantsRegistrar(publicClient, registry, minter))) {
      const step = "Letting Capsule register subnames";
      report?.({ step });
      const hash = await grantRegistrar({ walletClient, publicClient, registry, minter }, sub(step));
      report?.({ step, done: "Capsule may now register subnames under this name", tx: hash });
      status = await read();
      continue;
    }

    if (!(await minterHasResolverRoles(publicClient, minter, knownResolver))) {
      const step = "Letting Capsule write records";
      report?.({ step });
      const hash = await grantResolverRoles(
        { walletClient, publicClient, resolver: knownResolver, minter },
        sub(step),
      );
      report?.({ step, done: "Capsule may now write records under this name", tx: hash });
      status = await read();
      continue;
    }

    if (!status.connected) {
      const step = "Registering the name with Capsule";
      report?.({ step });
      const hash = await connectParent(
        {
          walletClient,
          publicClient,
          minter,
          registry,
          resolver: knownResolver,
          parent,
          open: args.open,
        },
        sub(step),
      );
      report?.({ step, done: `${parent.name} is connected to Capsule`, tx: hash });
      status = await read();
      continue;
    }

    return status;
  }

  return status;
}
