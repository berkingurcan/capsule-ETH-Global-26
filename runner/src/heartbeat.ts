/**
 * The heartbeat — the agent asking the protocol whether it is still allowed,
 * and then recording that it asked.
 *
 * Two operations, and the loop runs both at different cadences.
 *
 *   probeHeartbeat  eth_call. Free. Same modifier, same revert as the write, so
 *                   it detects a revocation just as well. Every tick.
 *   writeHeartbeat  a real transaction. Every HEARTBEAT_SECONDS.
 *
 * Why both, when the probe already answers the question: the probe is the
 * *check* and the write is the *record*. A free call proves the permission is
 * live to the process holding it and to nobody else — it leaves no trace, so
 * there is no on-chain last-seen, and an agent that quietly died last Tuesday
 * is indistinguishable from one that is fine. The write is what an observer
 * with only the chain can read. Probing between writes is what keeps a
 * revocation caught in seconds rather than in hours.
 *
 * Two habits matter here and both come out of hard-won notes:
 *
 *   simulate first    a denied write through cast reports "failed to estimate
 *                     gas" and nothing else. simulateContract runs it as a call
 *                     and hands back the decoded custom error for no gas.
 *
 *   check the receipt simulation passing does not mean the transaction lands.
 *                     A revoke arriving in between mines a reverted receipt —
 *                     which is exactly the race the demo creates on purpose.
 */
import type { Address, Hex, PublicClient } from "viem";
import type { RunnerWallet } from "./chain.js";
import type { CapsuleConfig } from "./config.js";
import { HEARTBEAT_KEY, heartbeatValue } from "./records.js";

export { heartbeatValue } from "./records.js";
import { inodeResolverAbi, resolverAbi } from "./resolve.js";

/** Sepolia blocks land in ~12s; well past that means something is wrong. */
const RECEIPT_TIMEOUT_MS = 90_000;

/**
 * What one beat costs. Measured on Sepolia, not estimated from first principles:
 *
 *   66,420   cast estimate, before any beat existed
 *   64,739   beat-1, the real transaction — writing over an empty record
 *   47,639   beat-2 onwards, steady state
 *
 * The first write to an empty string pays for fresh storage; every one after it
 * overwrites. Kept at the highest of the three deliberately — this only ever
 * turns a balance into a number of beats for a log line, and a warning that
 * arrives early is worth more than an estimate that flatters the wallet.
 */
export const BEAT_GAS = 66_420n;

/**
 * Below this many remaining beats, the boot log stops being informational.
 *
 * A count, not a balance: what matters is how long the agent can keep beating,
 * and that depends on the gas price on the day. 100 beats is a month at the
 * production cadence of three a day — enough warning to act on, and not so
 * eager that a demo wallet nags.
 */
export const LOW_BEATS = 100;

export type Funding = {
  balance: bigint;
  gasPrice: bigint;
  /** Whole beats affordable at the current price. */
  beats: number;
  low: boolean;
};

/**
 * How much longer this agent can afford to say it is alive.
 *
 * Read at boot and reported either way. An agent that cannot pay for its own
 * heartbeat still probes, still detects a revocation and still holds its
 * permission — it simply leaves no trace — so this is a warning and never a
 * gate. The one thing it must not do is stay quiet, because a stopped
 * heartbeat with no explanation is the exact shape of a revocation.
 */
export async function readFunding(
  publicClient: PublicClient,
  agent: Address,
): Promise<Funding> {
  const [balance, gasPrice] = await Promise.all([
    publicClient.getBalance({ address: agent }),
    publicClient.getGasPrice(),
  ]);

  const perBeat = BEAT_GAS * gasPrice;
  const beats = perBeat === 0n ? Number.MAX_SAFE_INTEGER : Number(balance / perBeat);

  return { balance, gasPrice, beats, low: beats < LOW_BEATS };
}

export type HeartbeatResult = {
  /** What was written, e.g. "beat-2". */
  value: string;
  hash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
};

/** Mined, but the chain rejected it. Distinct from a simulation failure. */
export class HeartbeatRevertedError extends Error {
  readonly hash: Hex;
  constructor(hash: Hex) {
    super("the heartbeat transaction reverted on chain");
    this.name = "HeartbeatRevertedError";
    this.hash = hash;
  }
}


/**
 * Asks the resolver whether this agent may still write its heartbeat, without
 * writing it.
 *
 * simulateContract is an eth_call: free, and it runs the same onlyPartRoles
 * modifier the real transaction would, so a revoked agent gets back the same
 * EACUnauthorizedAccountRoles it would get from a send.
 *
 * This runs every tick, between the paid writes, so the window between an
 * owner pressing Recall and the agent stopping is one tick and not one
 * heartbeat interval. It also costs nothing when the wallet is empty, which is
 * why an unfunded agent still knows whether it is authorized.
 *
 * Throws exactly what a denied write throws. halt.ts's classifier reads it.
 */
export async function probeHeartbeat(args: {
  publicClient: PublicClient;
  config: CapsuleConfig;
  agent: Address;
  /** The value a real write would use. Irrelevant to the check, kept honest. */
  sequence: number;
}): Promise<void> {
  const { publicClient, config, agent, sequence } = args;

  /* The two ENSv2 deployments take different arguments for this same write —
     a namehash on the beta, the DNS wire name on the hackathon revision — and
     the selectors differ, so there is no single shape that works on both.
     `config.inode` was probed at boot exactly so this costs no extra call. */
  if (config.inode) {
    await publicClient.simulateContract({
      address: config.resolver,
      abi: inodeResolverAbi,
      functionName: "setText",
      args: [config.dnsName, HEARTBEAT_KEY, heartbeatValue(sequence)],
      account: agent,
    });
    return;
  }

  await publicClient.simulateContract({
    address: config.resolver,
    abi: resolverAbi,
    functionName: "setText",
    args: [config.node, HEARTBEAT_KEY, heartbeatValue(sequence)],
    account: agent,
  });
}

export type WriteHeartbeatArgs = {
  publicClient: PublicClient;
  walletClient: RunnerWallet;
  config: CapsuleConfig;
  /** The beat to write. Read the previous one off the name and add one. */
  sequence: number;
};

/**
 * Writes one beat and waits for it.
 *
 * Deliberately awaits the receipt rather than firing and forgetting. The loop
 * beats on a timer, and a second transaction sent on the same nonce while the
 * first is unconfirmed kills one of them for no reason. A tick that takes
 * fifteen seconds to confirm simply starts the next one fifteen seconds later,
 * which is the correct behaviour for a liveness signal.
 *
 * Nothing here catches EACUnauthorizedAccountRoles, and nothing here catches an
 * empty wallet either. Both are halt.ts's job, and it needs the errors to
 * arrive intact — the difference between them is the difference between a
 * revoked agent and an unfunded one, and only one of those should stop.
 */
export async function writeHeartbeat(args: WriteHeartbeatArgs): Promise<HeartbeatResult> {
  const { publicClient, walletClient, config, sequence } = args;
  const value = heartbeatValue(sequence);

  // The address comes from the name, never from a constant: in production each
  // owner has their own resolver proxy, deployed by VerifiableFactory.
  const { request } = config.inode
    ? await publicClient.simulateContract({
        address: config.resolver,
        abi: inodeResolverAbi,
        functionName: "setText",
        args: [config.dnsName, HEARTBEAT_KEY, value],
        account: walletClient.account,
      })
    : await publicClient.simulateContract({
        address: config.resolver,
        abi: resolverAbi,
        functionName: "setText",
        args: [config.node, HEARTBEAT_KEY, value],
        account: walletClient.account,
      });

  // `request` is a union of the two resolvers' shapes and viem's overloads
  // cannot narrow it; the simulation above already type-checked whichever branch
  // produced it.
  const hash = await walletClient.writeContract(request as never);

  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: RECEIPT_TIMEOUT_MS,
  });

  if (receipt.status !== "success") throw new HeartbeatRevertedError(hash);

  return { value, hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
}
