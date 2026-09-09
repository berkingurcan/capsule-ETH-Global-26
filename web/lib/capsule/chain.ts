/**
 * Chain access for the server side. Read-only: the launchpad never signs a
 * transaction, because the user does.
 *
 * The minter ABI here is the subset the provisioner and the preflight need.
 * `checkResolverRoles` matters more than it looks: CapsuleMinter can only
 * write records because it holds root roles on the resolver, and those roles
 * can be revoked by the resolver's admin at any time. If that happens, every
 * mint reverts — after the user has already paid. Preflight checks it so the
 * failure is ours to see, not theirs to hit.
 */
import { createPublicClient, http, parseAbi, type PublicClient } from "viem";
import { sepolia } from "viem/chains";

export const CHAIN = sepolia;

/** ENSv2 Sepolia beta. The resolver address is per-owner, so every read goes
 *  through here rather than to a resolver we would have to know in advance. */
export const UNIVERSAL_RESOLVER_V2 = "0x4a1817d13e9cf196f471725176355c1234b63c70" as const;

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

export const minterAbi = parseAbi([
  "error ZeroAddress()",
  "error InvalidLabel(string label)",
  "error MissingResolverRoles()",
  // Field order is the ABI. Keep it identical to the struct in CapsuleMinter.sol —
  // viem encodes a tuple positionally, so a reordering here silently writes the
  // Telegram URL into `agent-context`.
  "struct CapsuleConfig { string context; string telegramUrl; string capsuleEndpoint; string model; string runtime; string promptPointer; }",
  "function mint(string label, address owner, address agent, CapsuleConfig config) returns (uint256 tokenId, bytes32 node)",
  "function nodeOf(string label) view returns (bytes32)",
  "function dnsNameOf(string label) view returns (bytes)",
  "function textResourceOf(bytes32 node, string key) pure returns (uint256)",
  "function isAgentAuthorized(string label, address agent) view returns (bool)",
  "function checkResolverRoles() view",
  "function PARENT_NODE() view returns (bytes32)",
  "function DURATION() view returns (uint64)",
  "function SCHEMA_URI() view returns (string)",
  // ENSIP-25. Read these rather than rebuilding the key locally: the interoperable
  // address is derived from the deployment's own chain id and address, so it changes
  // on every redeploy and a hardcoded copy goes stale without failing.
  "function REGISTRY_INTEROP_ADDRESS() view returns (string)",
  "function registrationKey(uint256 tokenId) view returns (string)",
  "function interopAddressOf(uint256 chainId, address account) pure returns (string)",
  // Carries no record values on purpose: the resolver emits its own event per
  // setText, so an indexer reads the config from there or from the records.
  "event CapsuleMinted(bytes32 indexed node, address indexed owner, address indexed agent, uint256 tokenId, string label, uint64 expiry)",
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
export function createServerClient(rpcUrl: string): PublicClient {
  return createPublicClient({
    chain: CHAIN,
    transport: http(rpcUrl, { batch: true }),
    batch: { multicall: true },
  });
}
