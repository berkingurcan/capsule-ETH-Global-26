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

export const minterAbi = parseAbi([
  "error ZeroAddress()",
  "error InvalidLabel(string label)",
  "error MissingResolverRoles()",
  "struct CapsuleConfig { string model; string endpoint; string promptPointer; }",
  "function mint(string label, address owner, address agent, CapsuleConfig config) returns (uint256 tokenId, bytes32 node)",
  "function nodeOf(string label) view returns (bytes32)",
  "function dnsNameOf(string label) view returns (bytes)",
  "function textResourceOf(bytes32 node, string key) pure returns (uint256)",
  "function isAgentAuthorized(string label, address agent) view returns (bool)",
  "function checkResolverRoles() view",
  "function PARENT_NODE() view returns (bytes32)",
  "function DURATION() view returns (uint64)",
  "event CapsuleMinted(bytes32 indexed node, address indexed owner, address indexed agent, uint256 tokenId, string label, string model, string endpoint, string promptPointer, uint64 expiry)",
]);

export function createServerClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: CHAIN, transport: http(rpcUrl) });
}
