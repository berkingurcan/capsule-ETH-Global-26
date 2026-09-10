/**
 * Buying a `.eth` name on the ENSv2 beta, as the four calls a browser can make.
 *
 * Client-safe: no env, no node:crypto, no server RPC. Every transaction here is
 * signed by the buyer, and none of them touches a Capsule contract — this page
 * talks only to ENS's registrar and to an ERC-20.
 *
 * ## Why this page exists at all
 *
 * Everything else in this app starts from a name its user already owns, which on
 * a deployment this young is not a safe assumption. The deployment's own manager
 * app can register names, but it quotes the price in a MockUSDC it gives you no
 * way to obtain — and the token has an open `mint`, so the missing piece is a
 * button, not a faucet. This page is that button plus the registration around it.
 *
 * ## Commit–reveal, and the one piece of state that has to survive
 *
 * `register()` is front-runnable: the label is in the calldata, so anyone
 * watching the mempool could take the name first and sell it back. ENS closes
 * that with a commitment — `commit(hash(label, owner, secret, …))`, wait
 * `MIN_COMMITMENT_AGE` (60s), then reveal by calling `register()` with the same
 * arguments. The hash tells a watcher nothing, and by the time the label is
 * public the commitment is already older than theirs.
 *
 * The consequence for a web app is that **the secret must outlive the page**.
 * Sixty seconds is long enough to reload, switch tabs, or lose a wallet popup,
 * and a secret held only in React state takes the paid-for commitment with it —
 * the user has spent gas on a commitment they can now never reveal, and has to
 * wait out `MAX_COMMITMENT_AGE` before the label is comfortably theirs again. So
 * it goes to `localStorage` before the commit transaction is signed, not after
 * it is mined: the failure we are protecting against includes the tab dying
 * while the wallet is open.
 *
 * It is written per (chain, owner, label, duration) because all four are inputs
 * to the commitment. Changing the duration after committing produces a different
 * hash, which is not an error condition worth handling — it is simply a different
 * commitment, and the page treats it as uncommitted.
 *
 * The secret is not a credential. It protects a name nobody else knows you want,
 * for sixty seconds, and it is worthless once the name is registered. Storing it
 * unencrypted in the browser is proportionate; storing it on our server would
 * mean holding something for a user that they can hold for themselves.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  formatUnits,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  CHAIN,
  ETH_REGISTRAR,
  PAYMENT_TOKENS,
  erc20Abi,
  ethRegistrarAbi,
  type PaymentToken,
} from "./chain";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

/** No referrer. The registrar takes one for fee-sharing; we are nobody's referrer. */
const REFERRER = ZERO_BYTES32;

/**
 * A name is registered bare: no subregistry, no resolver.
 *
 * `register()` accepts both, and setting the subregistry here would be the one
 * moment a fresh name could be handed the thing `/connect` currently dead-ends
 * on. It is deliberately not taken. A subregistry is a 31KB contract deployment
 * plus a two-way `setParent`/`setSubregistry` link, and half-wiring that link is
 * the failure that already cost this project a day (contracts/NOTES.md, gotcha
 * 1). Doing it wrong inside a registration would bake the mistake into the name
 * itself; doing it separately leaves it fixable. Both stay zero and are set
 * later, which the registrar explicitly supports.
 */
const SUBREGISTRY = ZERO_ADDRESS;
const RESOLVER = ZERO_ADDRESS;

export const DURATIONS = [
  { label: "28 days", seconds: 2_419_200 },
  { label: "1 year", seconds: 31_536_000 },
  { label: "2 years", seconds: 63_072_000 },
] as const;

export const DEFAULT_DURATION = 31_536_000;

export class RegisterError extends Error {
  /** `"rejected"` when the user dismissed the wallet: not worth a red banner. */
  readonly kind: "rejected" | "reverted" | "failed";
  constructor(kind: RegisterError["kind"], message: string) {
    super(message);
    this.name = "RegisterError";
    this.kind = kind;
  }
}

function revertMessage(name: string): string {
  switch (name) {
    case "NameNotAvailable":
      return "that name was taken between the check and the transaction";
    case "CommitmentTooNew":
      return "the sixty-second wait is not over yet";
    case "CommitmentTooOld":
      return "this commitment expired — commit again, the name is still yours to take";
    case "UnexpiredCommitmentExists":
      return "there is already a live commitment for exactly these details; reveal it instead of committing again";
    case "DurationTooShort":
      return "the registrar has a minimum registration period and this is under it";
    case "InvalidOwner":
      return "the owner address is not one the registrar will accept";
    case "SafeERC20FailedOperation":
      return "the token transfer failed — check the approval and the balance";
    case "PaymentTokenNotSupported":
      return "the registrar's price oracle does not accept that token";
    case "NotValid":
      return "the registrar's price oracle will not price that label";
    case "LabelAlreadyRegistered":
      return "that name is already registered";
    case "ERC20InsufficientAllowance":
      return "the approval is smaller than the fee — approve again";
    case "ERC20InsufficientBalance":
      return "your balance is smaller than the fee";
    case "ERC1155InvalidReceiver":
      /* A `.eth` name is an ERC-1155 token, so the registry mints it with an
         acceptance check. Any account with code — a smart wallet, or an EOA that
         has delegated under EIP-7702 — fails that check unless it implements
         `onERC1155Received`, and most do not. Worth its own sentence: the
         generic "reverted" sends someone hunting through their balance and
         their approval, neither of which is the problem. */
      return "this wallet cannot receive the name — a .eth name is an ERC-1155 token, and this account does not accept them. Register from a plain EOA and transfer it afterwards if you need it in a smart wallet";
    default:
      return `the transaction reverted with ${name}`;
  }
}

function explain(error: unknown): RegisterError {
  if (error instanceof BaseError) {
    const code = (error.walk() as { code?: number }).code;
    if (code === 4001 || /user (rejected|denied)/i.test(error.shortMessage ?? "")) {
      return new RegisterError("rejected", "Signature rejected in the wallet.");
    }
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName ?? reverted.reason;
      if (name !== undefined && name !== null) return new RegisterError("reverted", revertMessage(name));
      return new RegisterError("reverted", "the transaction reverted");
    }
    return new RegisterError("failed", error.shortMessage ?? error.message);
  }
  return new RegisterError("failed", error instanceof Error ? error.message : "the transaction failed");
}

/* ------------------------------------------------------------------ */
/* the label                                                           */
/* ------------------------------------------------------------------ */

/**
 * What is wrong with a label, in sentences a buyer can act on.
 *
 * Only the cheap, certain checks live here. Whether a label is *valid* is the
 * price oracle's opinion — `getRegisterPrice` reverts `NotValid` for anything it
 * will not price — and whether it is *free* is the registrar's, so both of those
 * are read off the chain rather than guessed at. This function exists to stop
 * someone typing `dev.berkin.eth` into a field that wants `berkin`.
 */
export function labelProblems(raw: string): string[] {
  const label = raw.trim();
  const problems: string[] = [];
  if (label === "") return ["type a name"];
  if (label.includes(".")) {
    problems.push("just the name — no dots, and no “.eth” on the end");
  }
  if (/\s/.test(label)) problems.push("names cannot contain spaces");
  if (label !== label.toLowerCase()) problems.push("names are lowercase");
  if (label.length < 3) problems.push("names are at least three characters");
  return problems;
}

/** `berkin` → `berkin.eth`, for display only. */
export function fullName(label: string): string {
  return `${label.trim().toLowerCase()}.eth`;
}

export function findToken(address: string): PaymentToken | undefined {
  return PAYMENT_TOKENS.find((t) => t.address.toLowerCase() === address.toLowerCase());
}

/** `8000021` on a 6-decimal token → `8.000021`, trailing zeros trimmed. */
export function formatAmount(amount: bigint, token: PaymentToken): string {
  const text = formatUnits(amount, token.decimals);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/* ------------------------------------------------------------------ */
/* the secret                                                          */
/* ------------------------------------------------------------------ */

export type Pending = {
  label: string;
  owner: Address;
  duration: number;
  secret: Hex;
  savedAt: number;
};

function storageKey(owner: Address, label: string, duration: number): string {
  return `capsule.register.${CHAIN.id}.${owner.toLowerCase()}.${label}.${duration}`;
}

/** 32 random bytes from the platform CSPRNG. Never derived from anything guessable. */
export function newSecret(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export function rememberSecret(pending: Pending): void {
  try {
    localStorage.setItem(
      storageKey(pending.owner, pending.label, pending.duration),
      JSON.stringify(pending),
    );
  } catch {
    /* Private mode, or a full quota. The commit still works; the reveal will
       need the same tab. Not worth blocking a registration over. */
  }
}

export function recallSecret(owner: Address, label: string, duration: number): Pending | null {
  try {
    const raw = localStorage.getItem(storageKey(owner, label, duration));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Pending;
    if (typeof parsed.secret !== "string" || !/^0x[0-9a-f]{64}$/i.test(parsed.secret)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function forgetSecret(owner: Address, label: string, duration: number): void {
  try {
    localStorage.removeItem(storageKey(owner, label, duration));
  } catch {
    /* nothing to do */
  }
}

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

export type RegisterStatus = {
  label: string;
  name: string;
  duration: number;
  token: PaymentToken;
  /** Null when the oracle refuses to price the label — an invalid name, not a taken one. */
  price: { base: bigint; premium: bigint; total: bigint } | null;
  available: boolean;
  balance: bigint;
  allowance: bigint;
  /** The chain's clock, not the browser's. The registrar compares against this one. */
  chainNow: number;
  minAge: number;
  maxAge: number;
  /** Present only when this browser holds the secret for these exact settings. */
  commitment: Hex | null;
  /** 0 when nothing is committed. */
  committedAt: number;
  /**
   * Whether the buyer's address has code.
   *
   * A `.eth` name is an ERC-1155 token and `ETHRegistry` mints it with an
   * acceptance check, so an account with code cannot receive one unless it
   * implements `onERC1155Received` — and smart wallets mostly do, while an EOA
   * that has delegated under EIP-7702 mostly does not. Read here so the page can
   * say it before the user pays for a commitment, rather than after `register()`
   * reverts on the last transaction of the flow.
   */
  ownerHasCode: boolean;
};

export type ReadArgs = {
  publicClient: PublicClient;
  owner: Address;
  label: string;
  duration: number;
  token: PaymentToken;
};

/**
 * One read that answers every question on the page.
 *
 * The same shape as `/connect`'s `readParentStatus`, and for the same reason:
 * a page whose rows are facts read off the chain shows where you actually are
 * after a reload, where a wizard holding step state in React shows where it
 * thinks you were. Registration spans two transactions with a mandatory wait
 * between them, so being interrupted is the normal case, not the edge case.
 */
export async function readRegistration(args: ReadArgs): Promise<RegisterStatus> {
  const { publicClient, owner, label, duration, token } = args;
  const registrar = { address: ETH_REGISTRAR as Address, abi: ethRegistrarAbi } as const;

  const [available, minAge, maxAge, balance, allowance, block, code] = await Promise.all([
    publicClient.readContract({ ...registrar, functionName: "isAvailable", args: [label] }),
    publicClient.readContract({ ...registrar, functionName: "MIN_COMMITMENT_AGE" }),
    publicClient.readContract({ ...registrar, functionName: "MAX_COMMITMENT_AGE" }),
    publicClient.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    }),
    publicClient.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, ETH_REGISTRAR as Address],
    }),
    publicClient.getBlock(),
    publicClient.getCode({ address: owner }),
  ]);

  // Priced separately: the oracle reverts `NotValid` on a label it will not
  // price, and that is an answer about the name rather than a failed read. It
  // must not take the rest of the page down with it.
  let price: RegisterStatus["price"] = null;
  try {
    const [base, premium] = await publicClient.readContract({
      ...registrar,
      functionName: "getRegisterPrice",
      args: [label, BigInt(duration), token.address],
    });
    price = { base, premium, total: base + premium };
  } catch {
    price = null;
  }

  // A commitment can only be found if this browser still holds its secret, which
  // is the honest thing to show: one it cannot reveal is one the user cannot use.
  let commitment: Hex | null = null;
  let committedAt = 0;
  const pending = recallSecret(owner, label, duration);
  if (pending !== null) {
    commitment = await publicClient.readContract({
      ...registrar,
      functionName: "makeCommitment",
      args: [label, owner, pending.secret, SUBREGISTRY, RESOLVER, BigInt(duration), REFERRER],
    });
    const at = await publicClient.readContract({
      ...registrar,
      functionName: "commitmentAt",
      args: [commitment],
    });
    committedAt = Number(at);
  }

  return {
    label,
    name: fullName(label),
    duration,
    token,
    price,
    available,
    balance,
    allowance,
    chainNow: Number(block.timestamp),
    minAge: Number(minAge),
    maxAge: Number(maxAge),
    commitment,
    committedAt,
    ownerHasCode: code !== undefined && code !== "0x",
  };
}

/** Seconds until the reveal is allowed; 0 once it is, and null when uncommitted. */
export function secondsUntilReveal(status: RegisterStatus, now: number): number | null {
  if (status.committedAt === 0) return null;
  return Math.max(0, status.committedAt + status.minAge - now);
}

/** True once the commitment is past `MAX_COMMITMENT_AGE` and has to be redone. */
export function commitmentExpired(status: RegisterStatus, now: number): boolean {
  return status.committedAt !== 0 && now > status.committedAt + status.maxAge;
}

/* ------------------------------------------------------------------ */
/* writing                                                             */
/* ------------------------------------------------------------------ */

export type RegisterStep = "simulating" | "signing" | "mining";
export type OnPhase = (phase: RegisterStep, detail?: string) => void;

type SendArgs = {
  walletClient: WalletClient;
  publicClient: PublicClient;
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
};

/** Simulate, sign, wait — `eth_call` answers for free what a revert answers expensively. */
async function send(args: SendArgs, onPhase?: OnPhase): Promise<Hex> {
  const account = args.walletClient.account;
  if (account === undefined) throw new RegisterError("failed", "the wallet client has no account");

  onPhase?.("simulating");
  let request;
  try {
    ({ request } = await args.publicClient.simulateContract({
      address: args.address,
      abi: args.abi as never,
      functionName: args.functionName,
      args: args.args as never,
      /* The account object, not `account.address`.

         Passing the address makes viem treat the caller as a JSON-RPC account,
         so the resulting request comes back with one attached and `writeContract`
         sends `eth_sendTransaction` — correct in a browser, where the wallet
         holds the key, and broken anywhere the key is local, because the node is
         asked to sign for an address it has never heard of. Passing the account
         through preserves whichever kind it already is, so the same code path
         works under `scripts/fork-register.ts` as in the page. */
      account,
    }));
  } catch (error) {
    throw explain(error);
  }

  onPhase?.("signing");
  let hash: Hex;
  try {
    hash = await args.walletClient.writeContract(request as never);
  } catch (error) {
    throw explain(error);
  }

  onPhase?.("mining", hash);
  const receipt = await args.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new RegisterError("reverted", "the transaction was mined but reverted");
  }
  return hash;
}

/**
 * Mints the caller some of a test token.
 *
 * Only ever called for a token whose `mintable` flag is set. Both mocks expose
 * `mint(to, amount)` with no access control at all, which is the whole point of
 * them — it is the deployment's faucet, and it happens to be a contract call
 * rather than a website.
 */
export async function mintTestTokens(
  args: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    token: PaymentToken;
    to: Address;
    amount: bigint;
  },
  onPhase?: OnPhase,
): Promise<Hex> {
  if (!args.token.mintable) {
    throw new RegisterError("failed", `${args.token.label} cannot be minted — it needs a faucet`);
  }
  return send(
    {
      walletClient: args.walletClient,
      publicClient: args.publicClient,
      address: args.token.address,
      abi: erc20Abi,
      functionName: "mint",
      args: [args.to, args.amount],
    },
    onPhase,
  );
}

/**
 * Approves the registrar to pull the fee.
 *
 * Approves exactly what this registration costs rather than the unlimited
 * allowance most apps ask for. The registrar is ENS's and is not the thing being
 * guarded against — the habit is. An app that teaches people to sign an infinite
 * approval for a one-off purchase has taught them the wrong reflex, and the cost
 * here is one extra approval if they register a second name.
 */
export async function approvePayment(
  args: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    token: PaymentToken;
    amount: bigint;
  },
  onPhase?: OnPhase,
): Promise<Hex> {
  return send(
    {
      walletClient: args.walletClient,
      publicClient: args.publicClient,
      address: args.token.address,
      abi: erc20Abi,
      functionName: "approve",
      args: [ETH_REGISTRAR as Address, args.amount],
    },
    onPhase,
  );
}

/**
 * Commits to a name.
 *
 * The secret is generated and persisted *before* the transaction is simulated,
 * which is the only ordering that survives the failure being guarded against:
 * a tab that dies with the wallet popup open has still put a commitment on
 * chain if the user signed, and a secret written after the receipt would be a
 * secret that never got written.
 */
export async function commitName(
  args: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    owner: Address;
    label: string;
    duration: number;
  },
  onPhase?: OnPhase,
): Promise<{ hash: Hex; secret: Hex; commitment: Hex }> {
  const { publicClient, owner, label, duration } = args;

  const existing = recallSecret(owner, label, duration);
  const secret = existing?.secret ?? newSecret();
  rememberSecret({ label, owner, duration, secret, savedAt: Math.floor(Date.now() / 1000) });

  const commitment = await publicClient.readContract({
    address: ETH_REGISTRAR as Address,
    abi: ethRegistrarAbi,
    functionName: "makeCommitment",
    args: [label, owner, secret, SUBREGISTRY, RESOLVER, BigInt(duration), REFERRER],
  });

  const hash = await send(
    {
      walletClient: args.walletClient,
      publicClient,
      address: ETH_REGISTRAR as Address,
      abi: ethRegistrarAbi,
      functionName: "commit",
      args: [commitment],
    },
    onPhase,
  );

  return { hash, secret, commitment };
}

/**
 * Reveals the commitment and buys the name.
 *
 * Every argument except the payment token has to match the commit byte for
 * byte, so they all come from the same constants and the same stored record
 * rather than from the form a second time. The token is genuinely free to
 * change here — it is not part of the commitment — so someone who committed
 * intending to pay in Circle USDC and then found their balance short can pay in
 * the test token without starting over.
 */
export async function registerName(
  args: {
    walletClient: WalletClient;
    publicClient: PublicClient;
    owner: Address;
    label: string;
    duration: number;
    token: PaymentToken;
  },
  onPhase?: OnPhase,
): Promise<Hex> {
  const { owner, label, duration } = args;
  const pending = recallSecret(owner, label, duration);
  if (pending === null) {
    throw new RegisterError(
      "failed",
      "this browser does not hold the secret for that commitment — commit again from here",
    );
  }

  const hash = await send(
    {
      walletClient: args.walletClient,
      publicClient: args.publicClient,
      address: ETH_REGISTRAR as Address,
      abi: ethRegistrarAbi,
      functionName: "register",
      args: [
        label,
        owner,
        pending.secret,
        SUBREGISTRY,
        RESOLVER,
        BigInt(duration),
        args.token.address,
        REFERRER,
      ],
    },
    onPhase,
  );

  // The secret has done its job and protects nothing now. Clearing it also stops
  // the next visit finding a commitment for a name that is already registered.
  forgetSecret(owner, label, duration);
  return hash;
}
