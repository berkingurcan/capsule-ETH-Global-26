/**
 * The chain the runner lives on, and what is deployed there.
 *
 * These are code, not configuration. The env-vars-only rule covers values that
 * differ per agent — a name, a key, an RPC endpoint. A Sepolia deployment
 * address is the same for every agent alive, so it belongs here where it can be
 * typed and reviewed.
 *
 * Notably absent: the resolver. Every owner gets their own PermissionedResolver
 * proxy from VerifiableFactory, so the runner learns its resolver by asking the
 * UniversalResolver where an answer came from. See readText() in resolve.ts.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { sepolia } from "viem/chains";

export const CHAIN = sepolia;

/** ENSv2 Sepolia beta. Entry point for every read: resolve(name, data). */
export const UNIVERSAL_RESOLVER_V2 = "0x4a1817d13e9cf196f471725176355c1234b63c70" as const;

export function createRunnerClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: CHAIN, transport: http(rpcUrl) });
}
