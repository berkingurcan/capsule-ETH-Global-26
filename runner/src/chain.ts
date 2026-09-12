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
import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";

export const CHAIN = sepolia;

/** ENSv2 Sepolia beta. Entry point for every read: resolve(name, data). */
export const UNIVERSAL_RESOLVER_V2 = "0x4a1817d13e9cf196f471725176355c1234b63c70" as const;

/** The ENS hackathon deployment's UniversalResolver. */
export const UNIVERSAL_RESOLVER_HACKATHON =
  "0xd26f2040D083Af1cD2962ba303F4BEa0c4faf142" as const;

/**
 * Both, in the order they are tried.
 *
 * Two ENSv2 deployments are live on Sepolia and a capsule's parent sits on
 * exactly one of them. Each UniversalResolver knows only its own names and
 * reverts `ResolverNotFound` for the other's, so a runner pinned to one address
 * cannot boot under a name registered on the other — it reads its own config
 * through this, so the failure is total rather than partial.
 *
 * Hackathon first: it is the deployment the official portal mints on, and so the
 * one most capsules will sit under.
 */
export const UNIVERSAL_RESOLVERS = [
  UNIVERSAL_RESOLVER_HACKATHON,
  UNIVERSAL_RESOLVER_V2,
] as const;

export function createRunnerClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: CHAIN, transport: http(rpcUrl) });
}

/**
 * Signs as the agent — the least privileged key in the system. It can write one
 * text record on one name and nothing else, which is the point.
 */
export function createRunnerWallet(rpcUrl: string, account: Account) {
  return createWalletClient({ account, chain: CHAIN, transport: http(rpcUrl) });
}

export type RunnerWallet = ReturnType<typeof createRunnerWallet>;
