/**
 * Topping up an agent's wallet, so it can pay for its own heartbeat.
 *
 * This is the only module in the web codebase that signs a transaction. Every
 * other write in the system is signed by the person in the browser or by the
 * agent in its container; this one is signed by us, because an agent that has
 * never run cannot pay for the write that proves it is running.
 *
 * ## Top up to a balance, never send an amount
 *
 * `fundAgent` reads the agent's balance and sends the difference. Sending a
 * fixed amount would make provisioning cost real ETH every time it was called,
 * and provisioning is a route a stranger can reach — the owner check bounds who
 * may call it for a given name, but nothing stops the owner calling it twenty
 * times. Reading the balance first makes the second call free, which is what
 * makes the route safe to retry after a failure further down.
 *
 * The chain is the record of what has been funded. There is no funding table,
 * for the same reason there is no session table: the answer is already on chain
 * and a second copy of it can only be wrong.
 *
 * ## Nonces
 *
 * Two provisions running at once would read the same nonce and one of them
 * would be dropped. Requests are therefore serialised through a promise chain
 * in this module — which holds for one server instance and not across a
 * horizontally scaled deployment, so a `replacement transaction underpriced` or
 * `nonce too low` is retried rather than treated as a failure. That is a real
 * limit and it is written down rather than papered over: the correct fix is a
 * single funding worker, and this is a hackathon.
 */
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN } from "./chain";

export class FundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingError";
  }
}

export type FundResult = {
  /** The agent's balance before anything was sent. */
  balanceBefore: bigint;
  /** Zero when the agent was already at or above the target. */
  sent: bigint;
  /** Null when nothing was sent. Not waited on — see below. */
  hash: Hex | null;
};

/** Nonce collisions inside one instance are prevented; across instances, retried. */
const RETRIES = 3;
function isNonceRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("nonce too low") ||
    message.includes("already known") ||
    message.includes("replacement transaction underpriced")
  );
}

/** Serialises funding within this instance. See the nonce note above. */
let queue: Promise<unknown> = Promise.resolve();
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  // Kept unhandled-rejection-safe: the caller gets the real promise, and the
  // chain itself must not stay rejected or every later call would fail with
  // somebody else's error.
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export type FundArgs = {
  rpcUrl: string;
  funderKey: Hex;
  agent: Address;
  /** The balance to bring the agent up to. Not the amount to send. */
  target: bigint;
};

/**
 * Brings `agent` up to `target` wei, and returns without waiting for the receipt.
 *
 * Not waiting is deliberate. A Sepolia block is ~12 seconds and this runs in a
 * serverless function with a request timeout; blocking on the receipt would
 * make provisioning flaky for no benefit, because the agent does not need the
 * ETH until its first heartbeat and the machine underneath it has an image to
 * pull first. The transaction is a plain value transfer from a balance we
 * checked, so the only ways it fails are ways that would also have failed the
 * send.
 */
export async function fundAgent(args: FundArgs): Promise<FundResult> {
  const account = privateKeyToAccount(args.funderKey);
  const publicClient = createPublicClient({ chain: CHAIN, transport: http(args.rpcUrl) });
  const walletClient = createWalletClient({ account, chain: CHAIN, transport: http(args.rpcUrl) });

  const balanceBefore = await publicClient.getBalance({ address: args.agent });
  if (balanceBefore >= args.target) {
    return { balanceBefore, sent: 0n, hash: null };
  }
  const amount = args.target - balanceBefore;

  return serialise(async () => {
    // Re-read inside the lock. Between the check above and here another
    // provision may have funded this same agent — two owners cannot, but one
    // owner clicking twice can, and paying twice for that is avoidable.
    const balance = await publicClient.getBalance({ address: args.agent });
    if (balance >= args.target) return { balanceBefore, sent: 0n, hash: null };

    const funderBalance = await publicClient.getBalance({ address: account.address });
    // A generous allowance for the transfer's own gas: 21,000 gas is the whole
    // cost of a value transfer, and at any plausible Sepolia price that is
    // dust. The point of the check is to refuse with a message that names the
    // funder and the shortfall, rather than to let viem report an insufficient
    // funds error from inside the send.
    const needed = amount + 10n ** 15n;
    if (funderBalance < needed) {
      throw new FundingError(
        `the funder ${account.address} holds ${formatEther(funderBalance)} ETH and needs ` +
          `${formatEther(needed)} to fund ${args.agent} — top it up`,
      );
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      try {
        const hash = await walletClient.sendTransaction({
          to: args.agent,
          value: amount,
          // Explicit, so a retry after a nonce race re-reads rather than
          // reusing a number viem cached for this client.
          nonce: await publicClient.getTransactionCount({
            address: account.address,
            blockTag: "pending",
          }),
        });
        return { balanceBefore, sent: amount, hash };
      } catch (error) {
        if (!isNonceRace(error) || attempt === RETRIES - 1) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new FundingError("could not send the funding transaction");
  });
}
