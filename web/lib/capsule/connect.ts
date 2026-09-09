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
 * ## What is NOT here
 *
 * Deploying the name's *subregistry*. A `.eth` name registered through the ENSv2
 * beta has no subregistry — `getSubregistry` answers the zero address — and until
 * it has one, nobody can issue subnames under it by any means. That is an ENS
 * primitive rather than a Capsule one: it is a 31KB contract deployment plus a
 * two-way `setParent`/`setSubregistry` link, and getting that link half-right is
 * the failure that cost this project a day (contracts/NOTES.md, gotcha 1). So the
 * page detects it, names it, and sends the user to the ENS manager, rather than
 * shipping a second implementation of it that can be wrong in a new way.
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
  PERMISSIONED_RESOLVER_IMPL,
  ROLE_REGISTRAR,
  VERIFIABLE_FACTORY,
  minterAbi,
  registryAbi,
  resolverAdminAbi,
  resolverInitAbi,
  verifiableFactoryAbi,
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

export async function deployResolver(
  args: { walletClient: WalletClient; publicClient: PublicClient; admin: Address },
  onPhase?: OnPhase,
): Promise<{ hash: Hex; resolver: Address }> {
  const initData = encodeFunctionData({
    abi: resolverInitAbi,
    functionName: "initialize",
    args: [args.admin, ALL_ROLES, []],
  });

  const { hash, logs } = await send(
    {
      walletClient: args.walletClient,
      publicClient: args.publicClient,
      address: VERIFIABLE_FACTORY,
      abi: verifiableFactoryAbi,
      functionName: "deployProxy",
      args: [PERMISSIONED_RESOLVER_IMPL, RESOLVER_SALT, initData],
    },
    onPhase,
  );

  // Read from the event, not from the simulation's return value. The address is
  // deterministic and the simulation would answer correctly — but a value read
  // off the mined receipt is the one that exists, and a deploy that emitted no
  // ProxyDeployed is not a resolver whatever the return data said.
  const events = parseEventLogs({
    abi: verifiableFactoryAbi,
    eventName: "ProxyDeployed",
    logs: logs as never,
  });
  const event = events.find(
    (e) => e.address.toLowerCase() === VERIFIABLE_FACTORY.toLowerCase(),
  );
  if (event === undefined) {
    throw new ConnectError("failed", "the transaction succeeded but emitted no ProxyDeployed event");
  }
  return { hash, resolver: event.args.proxyAddress };
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
