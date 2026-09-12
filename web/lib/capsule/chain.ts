/**
 * Chain access: the addresses, the ABIs, and the two derivations every other
 * module keys off.
 *
 * The clients built here are read-only — the app never holds a key. The one
 * write path it has, the recall in `recall.ts`, is signed by the user's own
 * wallet, and it uses `resolverAdminAbi` below.
 *
 * The minter ABI here is the subset the provisioner and the preflight need.
 * `checkResolverRoles` matters more than it looks: CapsuleMinter can only
 * write records because it holds root roles on the resolver, and those roles
 * can be revoked by the resolver's admin at any time. If that happens, every
 * mint reverts — after the user has already paid. Preflight checks it so the
 * failure is ours to see, not theirs to hit.
 */
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";

export const CHAIN = sepolia;

/**
 * There are two ENSv2 deployments live on Sepolia at once, and they share
 * nothing but the chain.
 *
 * `beta` is ENS's own long-running ENSv2 beta. `hackathon` is the deployment
 * behind the official hackathon portal, and is a LATER revision of the same
 * contracts — the one ENS DevRel points entrants at.
 *
 * A name registered on one does not exist on the other: `capsulefleet.eth`
 * resolves on `beta` and is an unregistered label on `hackathon`. That is not a
 * bug in either, and it is the entire reason this file is shaped as a table
 * instead of a list of constants.
 *
 * The registry ABI is identical across the two, verified by selector-diffing the
 * deployed bytecode. The RESOLVER ABI is not — see `inodeResolver`.
 */
export type EnsDeployment = "beta" | "hackathon";

export type DeploymentAddresses = {
  id: EnsDeployment;
  label: string;
  /** The resolver address is per-owner, so every read goes through here rather
   *  than to a resolver we would have to know in advance. */
  universalResolver: Address;
  /** The registry holding every `.eth` second-level name on this deployment. */
  ethRegistry: Address;
  /** Shared label database. Every registry is constructed against it, so a
   *  subregistry given the wrong one mints labels the rest of the deployment
   *  cannot see. */
  labelStore: Address;
  verifiableFactory: Address;
  permissionedResolverImpl: Address;
  ethRegistrar: Address;
  /**
   * `UserRegistry`, the implementation a name's subregistry is a proxy of.
   *
   * Only the hackathon deployment has one. On `beta` a subregistry is deployed
   * whole from vendored bytecode (`registry-bytecode.ts`) because there is no
   * factory for it; here it is a cheap `deployProxy`, which is strictly better
   * and lets the 31KB constant stay out of the bundle.
   */
  userRegistryImpl?: Address;
  /**
   * Whether this deployment's `PermissionedResolver` is the later "record"
   * revision, in which records are addressed by DNS wire name rather than
   * namehash and permissions hang off the setter ARGUMENT alone.
   *
   * The difference is not cosmetic and not a superset:
   *
   *   beta       setText(bytes32 node, string key, string value)
   *   hackathon  setText(bytes name,   string key, string value)
   *
   *   beta       setAddr(bytes32 node, address addr)
   *   hackathon  setAddress(bytes name, uint256 coinType, bytes addr)
   *
   *   beta       authorizeTextRoles(bytes name, string key, address, bool)
   *   hackathon  grantSetterRoles(bytes setter, address)   — NOT name-scoped
   *
   * `text(bytes32,string)` does not exist on the hackathon resolver at all:
   * reads there are ENSIP-10 only, through `resolve(name, data)`.
   *
   * See contracts/NOTES.md gotcha 16 for what the last line costs us.
   */
  inodeResolver: boolean;
  paymentTokens: readonly PaymentToken[];
};

/**
 * What the registrar will take as payment, and it is a fixed list.
 *
 * Price comes from a `RentPriceOracle` holding a token whitelist; anything not
 * on it reverts `PaymentTokenNotSupported` rather than falling back to ETH.
 * Read off the oracle's `PaymentTokenUpdated` logs rather than from the docs,
 * because the docs describe a MockUSDC and the list also contains the real one.
 *
 * `mintable` is the difference that matters to a user standing in front of this
 * app with an empty wallet. The two mocks expose an open `mint(to, amount)` that
 * anyone may call; Circle's USDC is a `FiatToken` whose `mint` reverts with
 * "caller is not a minter", so paying in it means finding a faucet first. Both
 * cost the same — 8.000021 for a year — and both produce exactly the same name.
 */
export type PaymentToken = {
  address: Address;
  symbol: string;
  label: string;
  decimals: number;
  /** Whether `mint(to, amount)` is open to anyone. */
  mintable: boolean;
  /** Where to get some, when minting is not an option. */
  faucet?: string;
  note: string;
};

export const DEPLOYMENTS: Record<EnsDeployment, DeploymentAddresses> = {
  hackathon: {
    id: "hackathon",
    label: "ENS hackathon deployment",
    universalResolver: "0xd26f2040D083Af1cD2962ba303F4BEa0c4faf142",
    ethRegistry: "0x1D78834d97c1D7b1A38c1deDBD1a287cFEd3971e",
    labelStore: "0xd7351f76866123a7e49381f38a30a96adba7e855",
    verifiableFactory: "0x894bc9cC8ff1ad96B8a288C86A8C71D662C07780",
    permissionedResolverImpl: "0xa9d3814AB151BF6E37A427432795371a8361614e",
    ethRegistrar: "0x7d1B7f586a62Ac3F54b9A396849757814283270b",
    userRegistryImpl: "0x47B442d0CF617c41CAbAFf5f02f44DD1e5f72546",
    inodeResolver: true,
    paymentTokens: [
      {
        address: "0xcBFD80F74375c54E545AF34788Ff465F96F66F05",
        symbol: "USDC",
        label: "Test USDC",
        decimals: 6,
        mintable: true,
        note: "this deployment's own token — mint yourself as much as you need, free",
      },
      {
        address: "0x93403a98c3A6be906585CD0D68447c0Fc600FB38",
        symbol: "DAI",
        label: "Test DAI",
        decimals: 18,
        mintable: true,
        note: "same deal as test USDC, eighteen decimals",
      },
    ],
  },
  beta: {
    id: "beta",
    label: "ENSv2 Sepolia beta",
    universalResolver: "0x4a1817d13e9cf196f471725176355c1234b63c70",
    ethRegistry: "0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2",
    labelStore: "0x532cd0cc4ac0793d838f71a67d29b2d790d18777",
    verifiableFactory: "0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef",
    permissionedResolverImpl: "0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e",
    ethRegistrar: "0xa88553f454b77203b0d036a05c894d555eaaa2cc",
    inodeResolver: false,
    paymentTokens: [
      {
        address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        symbol: "USDC",
        label: "Circle USDC",
        decimals: 6,
        mintable: false,
        faucet: "https://faucet.circle.com/",
        note: "the real Sepolia USDC — the registrar charges the same for it as for the test tokens",
      },
      {
        address: "0x768f42455a2d082e23ceef7d51e5787c82d67a39",
        symbol: "USDC",
        label: "Test USDC",
        decimals: 6,
        mintable: true,
        note: "this deployment's own token — mint yourself as much as you need, free",
      },
      {
        address: "0x5472c5725a00b7ba11f0794a79d08ade6f4683bd",
        symbol: "DAI",
        label: "Test DAI",
        decimals: 18,
        mintable: true,
        note: "same deal as test USDC, eighteen decimals",
      },
    ],
  },
};

/**
 * Which deployment this app registers NEW names on, and the fallback whenever a
 * name's own deployment cannot be determined.
 *
 * Defaults to `hackathon`, because that is the deployment the official portal
 * mints on and therefore the one a judge's name will live in. Reads still work
 * against both — `deploymentOfName` decides per name, not per process — so
 * capsules already minted on `beta` keep resolving with this set either way.
 */
export const DEFAULT_DEPLOYMENT: EnsDeployment =
  process.env.NEXT_PUBLIC_ENS_DEPLOYMENT === "beta" ? "beta" : "hackathon";

export const ACTIVE = DEPLOYMENTS[DEFAULT_DEPLOYMENT];

// Legacy flat exports, bound to the active deployment. Every call site that
// cares which deployment it is talking to takes a `DeploymentAddresses` instead;
// these remain for the paths where there is only ever one answer (`/register`
// sells names on the active deployment and nowhere else).
export const UNIVERSAL_RESOLVER_V2 = ACTIVE.universalResolver;
export const ETH_REGISTRY = ACTIVE.ethRegistry;
export const LABEL_STORE = ACTIVE.labelStore;
export const VERIFIABLE_FACTORY = ACTIVE.verifiableFactory;
export const PERMISSIONED_RESOLVER_IMPL = ACTIVE.permissionedResolverImpl;
export const ETH_REGISTRAR = ACTIVE.ethRegistrar;
export const PAYMENT_TOKENS = ACTIVE.paymentTokens;

export const ethRegistrarAbi = parseAbi([
  "error CommitmentTooNew(bytes32 commitment, uint64 validFrom, uint64 blockTimestamp)",
  "error CommitmentTooOld(bytes32 commitment, uint64 validTo, uint64 blockTimestamp)",
  "error DurationTooShort(uint64 duration, uint64 minDuration)",
  "error InvalidOwner()",
  "error NameNotAvailable(string label)",
  "error UnexpiredCommitmentExists(bytes32 commitment)",
  "error SafeERC20FailedOperation(address token)",
  "error NotValid(string label)",
  "error PaymentTokenNotSupported(address paymentToken)",
  "error LabelAlreadyRegistered(string label)",
  "error UnauthorizedCaller(address caller)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  // Raised by `ETHRegistry`, not the registrar: a name is an ERC-1155 token, so
  // registering one to a contract account that does not implement
  // `onERC1155Received` reverts. Undecodable without this line, and the message
  // it produces is the difference between a user switching wallets and a user
  // giving up.
  "error ERC1155InvalidReceiver(address receiver)",
  "event NameRegistered(uint256 indexed tokenId, string label, address owner, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 indexed referrer, uint256 base, uint256 premium)",
  "function MIN_COMMITMENT_AGE() view returns (uint64)",
  "function MAX_COMMITMENT_AGE() view returns (uint64)",
  "function MIN_REGISTER_DURATION() view returns (uint64)",
  "function commit(bytes32 commitment)",
  "function commitmentAt(bytes32 commitment) view returns (uint64)",
  "function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)",
  "function isAvailable(string label) view returns (bool)",
  "function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)",
  "function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)",
]);

/** The three ERC-20 calls `/register` makes, plus the mocks' open faucet. */
export const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
]);

/**
 * `EACBaseRolesLib.ALL_ROLES` — bit 0 of every nybble.
 *
 * What a fresh resolver's admin is granted at root, so the name's owner can do
 * anything on it: write records directly, delegate to the minter, and revoke
 * that delegation. Capsule asks for four of these roles and the owner keeps all
 * sixty-four, which is the correct asymmetry — we are a tenant of their
 * resolver, not its operator.
 */
export const ALL_ROLES =
  0x1111111111111111111111111111111111111111111111111111111111111111n;

export const verifiableFactoryAbi = parseAbi([
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
]);

export const resolverInitAbi = parseAbi([
  "function initialize(address admin, uint256 roleBitmap, bytes[] setters)",
]);

/**
 * The same job on the hackathon deployment, and a different shape.
 *
 * `beta` takes one admin and one bitmap; this takes a LIST of grants, which is
 * what lets /connect grant the owner and the minter in the single transaction
 * that deploys the proxy. The trailing `bytes[]` is multicalled during
 * initialization with permission checks suppressed, so records can be written
 * before any role exists to write them.
 */
export const resolverInitAbiV2 = parseAbi([
  "struct Grant { address account; uint256 roleBitmap; }",
  "function initialize(Grant[] grants, bytes[] calls)",
]);

/** `UserRegistry.initialize` — the hackathon deployment's subregistry proxy. */
export const userRegistryInitAbi = parseAbi([
  "struct Grant { address account; uint256 roleBitmap; }",
  "function initialize(Grant[] grants)",
]);

/**
 * The hackathon resolver's record calls.
 *
 * Every setter takes the DNS wire name where the beta takes a namehash, and
 * `setAddr(bytes32,address)` becomes `setAddress(name, coinType, bytes)`.
 * `text(bytes32,string)` has no counterpart at all — reads go through
 * `resolve()` below, which is ENSIP-10 and works on both deployments.
 *
 * `grantSetterRoles` is the replacement for `authorizeTextRoles`, and it is a
 * weaker thing than the name suggests: the resource is `keccak256(key)` with the
 * name playing no part, so a grant made through it reaches every name this
 * resolver serves. The `name` argument is decoded and discarded. That is why
 * /recall cannot narrow a revocation to one capsule here.
 */
export const inodeResolverAbi = parseAbi([
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error UnsupportedResolverProfile(bytes4 selector)",
  "error DNSDecodingFailed(bytes dns)",
  "function setText(bytes name, string key, string value)",
  "function setAddress(bytes name, uint256 coinType, bytes addressBytes)",
  "function grantSetterRoles(bytes setter, address account) returns (bool)",
  "function getRecordCount() view returns (uint256)",
  "function getRecordId(bytes32 node) view returns (uint256)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function grantRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function revokeRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)",
]);

/**
 * The EAC resource guarding one text key on the hackathon resolver.
 *
 * `keccak256(key)`, with no node in it — which is the whole of gotcha 16. The
 * beta's equivalent is `textResourceOf(node, key)` further down, and the two are
 * not interchangeable: passing a beta resource here silently answers about a
 * key nobody has.
 */
export function inodeTextResourceOf(key: string): bigint {
  return BigInt(keccak256(toHex(key)));
}


export const universalResolverAbi = parseAbi([
  "error ResolverNotFound(bytes name)",
  "error ResolverNotContract(bytes name, address resolver)",
  "error DNSDecodingFailed(bytes dns)",
  "error UnsupportedResolverProfile(bytes4 selector)",
  "function resolve(bytes name, bytes data) view returns (bytes, address)",
]);

export const resolverAbi = parseAbi([
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
  "function text(bytes32 node, string key) view returns (string)",
  "function addr(bytes32 node) view returns (address)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
]);

/**
 * The recall.
 *
 * Separate from `resolverAbi` because that one is a read ABI — it is encoded
 * into `UniversalResolver.resolve()` calls, where a write function has no
 * meaning. This one is pointed straight at the name's own resolver.
 *
 * `toName` is DNS wire format, NOT a namehash. The resolver namehashes it
 * itself (`NameCoder.namehash(toName, 0)`), so passing 32 bytes of node here
 * compiles, encodes, and revokes a role on a name nobody owns.
 *
 * The errors are here so a revert reaches the user as a sentence rather than a
 * bare selector. `EACCannotRevokeRoles` is the one an ordinary wallet hits: it
 * is what the resolver says when the caller does not hold
 * `ROLE_SET_TEXT_ADMIN` on the name. `EACRolesChanged` is the receipt — the
 * revoke is only real if the mined transaction emitted it.
 */
export const resolverAdminAbi = parseAbi([
  "error DNSDecodingFailed(bytes dns)",
  "error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account)",
  "error EACInvalidAccount()",
  "error EACInvalidRoleBitmap(uint256 roleBitmap)",
  "error EACMinAssignees(uint256 resource, uint256 role)",
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
  "event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)",
  "function authorizeTextRoles(bytes toName, string key, address account, bool grant) returns (bool)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  // The other write this app sends, from /connect: a parent's admin granting the
  // minter the root roles it needs to write records under their name. Root rather
  // than per-name because the capsule names do not exist yet at that point.
  "function grantRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)",
]);

/**
 * Writing a text record as the name's owner.
 *
 * The second thing this app sends, and the first that is not a revocation. The
 * launchpad uses it to set `agent-spend-cap` right after a mint, because
 * `CapsuleMinter` does not write that key — no deployed minter knows it exists —
 * and the owner is the only account that can.
 *
 * They can because `mint()` grants them `OWNER_NAME_ROLES` on their own name,
 * which is `ROLE_SET_TEXT | ROLE_SET_TEXT_ADMIN` scoped to it. The same grant
 * that makes the recall possible makes this possible, and it is the reason a
 * spending policy needed no contract change.
 *
 * `node` is a namehash here, NOT the DNS wire format `authorizeTextRoles`
 * takes. The two live side by side in this file and are not interchangeable:
 * passing DNS bytes to `setText` writes a record on a name nobody owns.
 *
 * `EACUnauthorizedAccountRoles` is the revert an account without the role
 * gets — and per the resolver's `onlyPartRoles` modifier it names the
 * name-level resource whichever key was denied, so never read the key out of it.
 */
export const resolverTextAbi = parseAbi([
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
  "function setText(bytes32 node, string key, string value)",
  "function text(bytes32 node, string key) view returns (string)",
]);

/**
 * `ROLE_SET_TEXT` and its admin, from `PermissionedResolverLib`.
 *
 * Roles are nybble-packed — each occupies four bits — and the admin
 * counterpart sits 128 bits higher. The agent holds the first on one key of
 * one name; the owner holds the second on the whole name, which is the only
 * reason the owner can take the first away.
 */
export const ROLE_SET_TEXT = 1n << 4n;
export const ROLE_SET_TEXT_ADMIN = ROLE_SET_TEXT << 128n;

/**
 * `ROLE_REGISTRAR` and its admin, from `RegistryRolesLib`.
 *
 * A different role table from the resolver's above, on a different contract,
 * with the same bit values and entirely different meanings — which is exactly
 * why both are spelled out here rather than shared. `ROLE_REGISTRAR` is what
 * `CapsuleMinter` needs on a parent's registry before it can register subnames
 * there; `ROLE_REGISTRAR_ADMIN` is what lets an account grant it, and is
 * therefore what the minter treats as proof that somebody controls the parent.
 */
export const ROLE_REGISTRAR = 1n << 0n;
export const ROLE_REGISTRAR_ADMIN = ROLE_REGISTRAR << 128n;

/**
 * `ROLE_SET_SUBREGISTRY` — permission to point a name at a registry.
 *
 * Held on `ETH_REGISTRY` against the name's own token id rather than on the
 * root, and granted to the owner by the registrar at registration time. It is
 * what makes the subregistry step something the name's owner can do from a
 * browser instead of something only ENS could do for them, so /connect reads it
 * before offering the step at all.
 */
export const ROLE_SET_SUBREGISTRY = 1n << 20n;

/**
 * `PermissionedResolverLib.resource(node, part)` — the EAC resource id.
 *
 * Two of them matter here and they are not interchangeable:
 *
 *   - `textResourceOf(node, key)` — one key on one name. This is what the
 *     agent's write permission lives on, and what a recall clears.
 *   - `nameResourceOf(node)` — the name itself, `resource(node, 0)`. This is
 *     what the resolver checks the *caller* against before it will revoke, and
 *     what `setText` reverts against regardless of which key was denied.
 *
 * Computed rather than called so a fleet-wide role query costs no round trips.
 * `scripts/check-fleet.ts` asserts the first against `CapsuleMinter`, and
 * `scripts/check-recall.ts` asserts the second by simulating a real revoke.
 */
export function textResourceOf(node: Hex, key: string): bigint {
  return resourceOf(node, keccak256(toHex(key)));
}

export function nameResourceOf(node: Hex): bigint {
  return resourceOf(node, `0x${"00".repeat(32)}` as Hex);
}

function resourceOf(node: Hex, part: Hex): bigint {
  return BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [node, part])));
}

export const minterAbi = parseAbi([
  "error ZeroAddress()",
  "error InvalidLabel(string label)",
  "error InvalidName(bytes dnsName)",
  "error MissingResolverRoles()",
  // The four the multi-parent flow can actually hit. Named here so a revert reaches
  // the user as a sentence about which setup step is missing, rather than a selector.
  "error NotParentAdmin(address registry, address account)",
  "error ParentNotConnected(address registry)",
  "error ParentNotOpen(address registry, address account)",
  "error ParentLinkBroken(address registry)",
  // Field order is the ABI. Keep it identical to the struct in CapsuleMinter.sol —
  // viem encodes a tuple positionally, so a reordering here silently writes the
  // Telegram URL into `agent-context`.
  "struct CapsuleConfig { string context; string telegramUrl; string capsuleEndpoint; string model; string runtime; string promptPointer; }",
  // The parent is named by its REGISTRY, not by its name or its resolver. The minter
  // stores the rest against that address at connect time, so there is no way for this
  // app to pair a real parent's registry with the wrong resolver — see the contract's
  // "One minter, many parents" note for why that pairing had to be made unrepresentable.
  "function mint(address registry, string label, address owner, address agent, CapsuleConfig config) returns (uint256 tokenId, bytes32 node)",

  // --- the connect flow, sent from /connect by the parent's own admin ---
  "function connectParent(address registry, address resolver, bytes parentDns, bool open)",
  "function setParentOpen(address registry, bool open)",
  "function disconnectParent(address registry)",

  // --- what the launch form and /connect read before they let anyone sign ---
  // `inode` is the sixth return and says which ENSv2 deployment the parent's
  // resolver belongs to — the minter detects it at connect time by probing for a
  // function only the hackathon revision has. Read it rather than guessing: it
  // decides which resolver ABI a record write has to speak.
  "function parentOf(address registry) view returns (bool connected, bool open, address resolver, bytes32 node, bytes dnsName, bool inode)",
  // One call, five booleans: connected, the two grants, open, and whether THIS account
  // would get past the check. The form gates every button on it, because the
  // alternative is finding out which step was skipped from a revert after signing.
  "function readiness(address registry, address account) view returns (bool connected, bool registrarGranted, bool resolverRolesGranted, bool open, bool callerMayMint)",

  "function nodeOf(address registry, string label) view returns (bytes32)",
  "function dnsNameOf(address registry, string label) view returns (bytes)",
  // The contract's own namehash over a DNS wire name, exposed so /connect can show the
  // node it is about to store and compare it against viem's `namehash` of the same
  // name. Two independent implementations agreeing is the check; the contract derives
  // the node from the DNS name precisely so the two can never be configured apart.
  "function namehash(bytes dnsName) pure returns (bytes32)",
  "function textResourceOf(bytes32 node, string key) pure returns (uint256)",
  "function isAgentAuthorized(address registry, string label, address agent) view returns (bool)",
  "function checkResolverRoles(address resolver) view",
  "function REQUIRED_RESOLVER_ROOT_ROLES() view returns (uint256)",
  "function DURATION() view returns (uint64)",
  "function SCHEMA_URI() view returns (string)",
  // ENSIP-25. Read these rather than rebuilding the key locally: the interoperable
  // address is derived from the deployment's own chain id and address, so it changes
  // on every redeploy and a hardcoded copy goes stale without failing. It is the
  // MINTER's address, not the parent's, so it is the same for every capsule this
  // deployment issues whatever name they sit under.
  "function REGISTRY_INTEROP_ADDRESS() view returns (string)",
  "function registrationKey(uint256 tokenId) view returns (string)",
  "function interopAddressOf(uint256 chainId, address account) pure returns (string)",
  // Carries no record values on purpose: the resolver emits its own event per
  // setText, so an indexer reads the config from there or from the records.
  //
  // `parentNode` is indexed and `agent` is not — three topics is the ABI limit, and a
  // dashboard showing one name's fleet filters on the parent every time it loads.
  // `readFleet` passes it as a topic argument, which is what keeps two names' capsules
  // from appearing in each other's dashboards.
  "event CapsuleMinted(bytes32 indexed parentNode, bytes32 indexed node, address indexed owner, address agent, uint256 tokenId, string label, uint64 expiry)",
  "event ParentConnected(bytes32 indexed parentNode, address indexed registry, address indexed resolver, address by, bool open)",
  "event ParentDisconnected(bytes32 indexed parentNode, address indexed registry, address by)",
]);

/**
 * The ENSv2 subregistry holding capsule labels, reached via `minter.REGISTRY()`.
 *
 * `findOwner` is the provisioner's authorisation primitive, and it is the
 * *current* owner rather than the address in the `CapsuleMinted` log — a name
 * that has been transferred belongs to whoever holds it now, and the log is a
 * record of who held it once. Names it has never issued return the zero
 * address, which is how "not minted" is spelled.
 *
 * Not `findTokenId`: that returns a non-zero id for a label nobody has ever
 * registered, because the id is derived from the label rather than looked up.
 * Using it as an existence check would report every free name as taken.
 */
export const registryAbi = parseAbi([
  "function findOwner(string label) view returns (address owner)",
  "function findTokenId(string label) view returns (uint256 tokenId)",
  // `ETH_REGISTRY.getSubregistry("berkin")` is how a name becomes a registry address,
  // which is the only handle on a parent this app ever needs. Zero means the name has
  // no subregistry yet, and therefore cannot issue subnames to anyone — the first
  // thing /connect checks, and the one problem it cannot fix for you.
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  // The upward half of the two-way link. `connectParent` verifies both halves on
  // chain; /connect reads this one so it can say which name a registry belongs to
  // before asking anybody to sign.
  "function getParent() view returns (address parent, string label)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function grantRootRoles(uint256 roleBitmap, address account) returns (bool)",
  "function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)",
  // The two halves of the link that gives a name a subregistry. `setSubregistry`
  // is sent to ETH_REGISTRY against the name's token id; `setParent` is sent to
  // the new registry itself. Both are required and neither implies the other —
  // getting that wrong is gotcha 1 in contracts/NOTES.md.
  "function setSubregistry(uint256 anyId, address registry)",
  "function setParent(address parent, string label)",
]);

/**
 * `PermissionedRegistry`'s constructor, on its own.
 *
 * `registryAbi` is a list of function signatures and so has no constructor
 * entry, which `deployContract` requires — it needs somewhere to encode
 * `(labelStore, rootAccount, roleBitmap)` against. Kept separate rather than
 * folded in so the ABI used for reads stays exactly the set of calls this app
 * makes.
 */
export const registryDeployAbi = parseAbi([
  "constructor(address labelStore, address rootAccount, uint256 roleBitmap)",
]);

/**
 * `batch` on both levels, because the fleet read is dozens of small calls.
 *
 * `multicall: true` folds concurrent `readContract` calls into one Multicall3
 * call; `http({ batch: true })` folds whatever is left — `eth_getBlockByNumber`
 * for event timestamps, mostly — into one HTTP request. Without them a
 * four-capsule fleet is around sixty round trips to a public RPC, which is both
 * slow and a good way to get rate limited mid-render.
 */
/**
 * Which deployment a second-level `.eth` label actually lives on.
 *
 * Both registries are asked in parallel and the one that reports an owner wins.
 * A label registered on neither returns `null`, which is a real and common
 * answer — it is what an unregistered name looks like — and callers should say
 * "not registered" rather than guessing a deployment.
 *
 * This is the function that makes dual support more than a build-time switch: a
 * user pastes a name and the app works out where it is, instead of being told by
 * an environment variable that is right half the time. `findOwner` rather than
 * `findTokenId`, because the latter derives an id from the label and so returns
 * non-zero for names nobody has ever registered.
 */
export async function deploymentOfName(
  client: PublicClient,
  label: string,
): Promise<DeploymentAddresses | null> {
  const candidates = Object.values(DEPLOYMENTS);
  const owners = await Promise.all(
    candidates.map((d) =>
      client
        .readContract({
          address: d.ethRegistry,
          abi: registryAbi,
          functionName: "findOwner",
          args: [label],
        })
        .catch(() => ZERO_ADDRESS),
    ),
  );
  const hits = candidates.filter((_, i) => owners[i] !== ZERO_ADDRESS);
  // A label held on both is possible — nothing stops the same word being
  // registered twice by different people — so prefer the active deployment
  // rather than whichever Object.values happened to order first.
  return hits.find((d) => d.id === DEFAULT_DEPLOYMENT) ?? hits[0] ?? null;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export function createServerClient(rpcUrl: string): PublicClient {
  return createPublicClient({
    chain: CHAIN,
    transport: http(rpcUrl, { batch: true }),
    batch: { multicall: true },
  });
}
