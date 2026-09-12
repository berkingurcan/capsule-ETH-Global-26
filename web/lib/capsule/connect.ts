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
  encodeFunctionData,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
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
import type { ParentName } from "./parent";

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
  },
  onPhase?: OnPhase,
): Promise<{ hash: Hex; registry: Address }> {
  const account = args.walletClient.account;
  if (account === undefined) throw new ConnectError("failed", "the wallet client has no account");

  // The hackathon deployment has a `UserRegistry` implementation, so a
  // subregistry there is a proxy rather than a whole contract: one `deployProxy`
  // instead of five million gas of creation code, and the 31KB bytecode chunk
  // never loads. The beta has no such implementation, which is the only reason
  // that constant exists at all.
  if (args.deployment.userRegistryImpl !== undefined) {
    const initData = encodeFunctionData({
      abi: userRegistryInitAbi,
      functionName: "initialize",
      args: [[{ account: args.owner, roleBitmap: ALL_ROLES }]],
    });
    const { hash, resolver: registry } = await deployProxyVia(
      {
        walletClient: args.walletClient,
        publicClient: args.publicClient,
        deployment: args.deployment,
        implementation: args.deployment.userRegistryImpl,
        salt: REGISTRY_SALT,
        initData,
      },
      onPhase,
    );
    return { hash, registry };
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
  return { hash, registry };
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
  },
  onPhase?: OnPhase,
): Promise<{ hash: Hex; resolver: Address }> {
  // The two deployments disagree on `initialize`: the beta takes one admin and
  // one bitmap, the hackathon revision takes a list of grants and a list of
  // calls to multicall during initialization.
  const initData = args.deployment.inodeResolver
    ? encodeFunctionData({
        abi: resolverInitAbiV2,
        functionName: "initialize",
        args: [[{ account: args.admin, roleBitmap: ALL_ROLES }], []],
      })
    : encodeFunctionData({
        abi: resolverInitAbi,
        functionName: "initialize",
        args: [args.admin, ALL_ROLES, []],
      });

  return deployProxyVia(
    {
      walletClient: args.walletClient,
      publicClient: args.publicClient,
      deployment: args.deployment,
      implementation: args.deployment.permissionedResolverImpl,
      salt: RESOLVER_SALT,
      initData,
    },
    onPhase,
  );
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
