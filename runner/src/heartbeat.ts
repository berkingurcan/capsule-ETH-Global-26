/**
 * The heartbeat — the agent asking the protocol whether it is still allowed.
 *
 * Two ways to ask, and the runner uses the cheap one.
 *
 *   probeHeartbeat  eth_call. Free. Same modifier, same revert. This is what
 *                   the loop runs, every tick.
 *   writeHeartbeat  a real transaction. Kept as a manual tool, not called by
 *                   the loop: paying gas to learn what a free call already
 *                   tells you does not become a better answer.
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
import { resolverAbi } from "./resolve.js";

/** Sepolia blocks land in ~12s; well past that means something is wrong. */
const RECEIPT_TIMEOUT_MS = 90_000;

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
 * EACUnauthorizedAccountRoles it would get from a send. The permission being
 * probed is real and revocable; the agent simply checks it rather than
 * spending gas to exercise it.
 *
 * The consequence worth knowing: agent-heartbeat never advances on chain, so
 * an on-chain "last seen" is not available. The owner's revocation event is,
 * and that is the one the subgraph in build step 5 cares about.
 *
 * Throws exactly what a denied write throws. Task 6's classifier reads it.
 */
export async function probeHeartbeat(args: {
  publicClient: PublicClient;
  config: CapsuleConfig;
  agent: Address;
  /** The value a real write would use. Irrelevant to the check, kept honest. */
  sequence: number;
}): Promise<void> {
  const { publicClient, config, agent, sequence } = args;

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
 * Nothing here catches EACUnauthorizedAccountRoles. That is the next task's
 * job, and it needs the error to arrive intact.
 */
export async function writeHeartbeat(args: WriteHeartbeatArgs): Promise<HeartbeatResult> {
  const { publicClient, walletClient, config, sequence } = args;
  const value = heartbeatValue(sequence);

  // The address comes from the name, never from a constant: in production each
  // owner has their own resolver proxy, deployed by VerifiableFactory.
  const { request } = await publicClient.simulateContract({
    address: config.resolver,
    abi: resolverAbi,
    functionName: "setText",
    args: [config.node, HEARTBEAT_KEY, value],
    account: walletClient.account,
  });

  const hash = await walletClient.writeContract(request);

  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: RECEIPT_TIMEOUT_MS,
  });

  if (receipt.status !== "success") throw new HeartbeatRevertedError(hash);

  return { value, hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
}
