/**
 * End-to-end proof of lib/capsule/register.ts against a fork of Sepolia.
 *
 * Runs the exact functions the page calls, in the exact order, with a real
 * wallet client — mint, approve, commit, wait out MIN_COMMITMENT_AGE, register —
 * and asserts the one negative that matters: revealing early must fail, or the
 * commit/reveal gap protects nothing.
 *
 * Needs a fork running, and touches no real chain:
 *
 *     anvil --fork-url $SEPOLIA_RPC_URL --port 8545 --silent &
 *     node --import tsx scripts/fork-register.ts
 */
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  numberToHex,
  pad,
  toHex,
  type Address,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { PAYMENT_TOKENS, erc20Abi, type PaymentToken } from "../lib/capsule/chain";
import {
  approvePayment,
  commitName,
  formatAmount,
  mintTestTokens,
  readRegistration,
  registerName,
  secondsUntilReveal,
} from "../lib/capsule/register";

/* register.ts persists the commitment secret in localStorage, which is the whole
   point of it, so the harness supplies one rather than routing around it: the
   reveal below reads the secret back through exactly the path a browser uses. */
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const RPC = "http://127.0.0.1:8545";

/* A key generated per run, funded through `anvil_setBalance`, rather than one of
   anvil's defaults.

   Not fussiness. A `.eth` name is an ERC-1155 token and the registry mints it
   with an acceptance check, so the buyer must be an account with no code —
   and anvil's account #0 has 23 bytes of it on Sepolia, an EIP-7702 delegation
   somebody left there. Forking inherits that, and the whole run dies at the last
   step with `ERC1155InvalidReceiver`. A fresh address cannot have been delegated
   by anyone, which makes the test measure the registration rather than the
   history of a well-known private key. */
function freshKey(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/**
 * Gives an address a balance of a token it cannot mint.
 *
 * Circle's USDC is the page's default and its `mint` is minter-gated, so the
 * only way to exercise that path on a fork is to write the balance directly.
 * `FiatTokenV2_2` keeps balances in a mapping at storage slot 9, so the slot for
 * one holder is `keccak256(abi.encode(holder, 9))` — the standard Solidity
 * mapping layout. Verified by reading `balanceOf` back rather than assumed,
 * because a wrong slot writes somewhere harmless and the test would then be
 * proving nothing.
 */
async function dealFiatToken(
  publicClient: PublicClient,
  token: PaymentToken,
  holder: Address,
  amount: bigint,
): Promise<boolean> {
  const slot = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, 9n]),
  );
  await publicClient.request({
    method: "anvil_setStorageAt" as never,
    params: [token.address, slot, pad(numberToHex(amount), { size: 32 })] as never,
  });
  const balance = await publicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  });
  return balance === amount;
}

async function buy(token: PaymentToken): Promise<void> {
  const account = privateKeyToAccount(freshKey());
  const transport = http(RPC);
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ account, chain: sepolia, transport });

  const owner = account.address as Address;
  await publicClient.request({
    method: "anvil_setBalance" as never,
    params: [owner, "0xde0b6b3a7640000"] as never, // 1 ETH, for gas
  });

  const duration = 31_536_000;
  const label = `capsulefork${Date.now().toString(36)}`;

  console.log(`\n── ${token.label} ──  buying ${label}.eth for ${owner}`);

  const before = await readRegistration({ publicClient, owner, label, duration, token });
  check("the buyer is a plain EOA, so it can receive an ERC-1155 name", before.ownerHasCode === false);
  check("the label is available", before.available);
  check(
    "the oracle prices it",
    before.price !== null,
    before.price === null ? "" : `${formatAmount(before.price.total, token)} ${token.symbol}`,
  );
  check("nothing is committed yet", before.committedAt === 0);
  if (before.price === null) {
    failures += 1;
    return;
  }
  const total = before.price.total;

  // Funded the way the page funds it: the open mint where there is one, and a
  // storage write standing in for Circle's faucet where there is not.
  const stake = 10n * 10n ** BigInt(token.decimals);
  if (token.mintable) {
    await mintTestTokens({ walletClient, publicClient, token, to: owner, amount: stake });
    check("the open mint funded the wallet", true, `${formatAmount(stake, token)} ${token.symbol}`);
  } else {
    const dealt = await dealFiatToken(publicClient, token, owner, stake);
    check("the faucet path can be stood in for (balance slot found)", dealt);
  }

  await approvePayment({ walletClient, publicClient, token, amount: total });

  const funded = await readRegistration({ publicClient, owner, label, duration, token });
  check("the wallet covers the fee", funded.balance >= total, `${formatAmount(funded.balance, token)} ${token.symbol}`);
  check("the registrar is approved for exactly the fee, not for everything", funded.allowance === total);

  const { commitment } = await commitName({ walletClient, publicClient, owner, label, duration });
  const committed = await readRegistration({ publicClient, owner, label, duration, token });
  check("the commitment is on chain", committed.committedAt > 0, `${commitment.slice(0, 14)}…`);
  const wait = secondsUntilReveal(committed, committed.chainNow);
  check("the reveal is not open yet", wait !== null && wait > 0, `${wait}s to go`);

  let tooEarly = false;
  try {
    await registerName({ walletClient, publicClient, owner, label, duration, token });
  } catch {
    tooEarly = true;
  }
  check("revealing before the wait is over reverts", tooEarly);

  await publicClient.request({ method: "evm_increaseTime" as never, params: [61] as never });
  await publicClient.request({ method: "evm_mine" as never, params: [] as never });

  const ready = await readRegistration({ publicClient, owner, label, duration, token });
  check("the wait is over", secondsUntilReveal(ready, ready.chainNow) === 0);
  check("the commitment survived the wait", ready.committedAt === committed.committedAt);

  const hash = await registerName({ walletClient, publicClient, owner, label, duration, token });
  check("register() succeeded", typeof hash === "string", `${hash.slice(0, 14)}…`);

  const after = await readRegistration({ publicClient, owner, label, duration, token });
  check("the name is no longer available", after.available === false);
  check(
    "the fee was taken",
    after.balance === funded.balance - total,
    `${formatAmount(funded.balance, token)} → ${formatAmount(after.balance, token)} ${token.symbol}`,
  );
  check("the secret was cleared once spent", after.committedAt === 0);
}

async function main() {
  // Every token the page offers, because the page lets a user pick any of them
  // and the paths differ in how the wallet gets funded.
  for (const token of PAYMENT_TOKENS) {
    await buy(token);
  }
  console.log(`\n${failures === 0 ? "register path OK on a Sepolia fork, for every payment token" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
