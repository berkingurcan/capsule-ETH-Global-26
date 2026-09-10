/**
 * The teller window, against a real chain, without spending anything real.
 *
 * `dev/gateway-smoke.ts` proves the seam between the supervisor and the gateway
 * with no chain. This proves the other seam — supervisor to chain — with no
 * gateway, and it needs a real one because the interesting failures are not in
 * the policy arithmetic. They are in the parts that only exist once a
 * transaction is actually being signed: the nonce two writers share, a gas
 * estimate that has to match what the policy priced, a receipt that has to come
 * back before the run total moves.
 *
 * Anvil, forked from nothing, chain id pinned to Sepolia's so the wallet client
 * this runner builds is the one under test rather than a special one built for
 * the test.
 *
 *   anvil --chain-id 11155111 --port 8545 --silent &
 *   npm run dev:wallet-smoke
 *
 * `npm run dev:wallet` does both and cleans up after itself.
 */
import { formatEther, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRunnerClient, createRunnerWallet } from "../src/chain.js";
import { parseSpendPolicy, type SpendPolicy } from "../src/policy.js";
import { Serializer } from "../src/serial.js";
import { WalletBroker } from "../src/wallet.js";

const RPC = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const PORT = 8899;

/** anvil's first two default accounts. Public, deterministic, worthless. */
const AGENT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const STRANGER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;

/** Stands in for the name's resolver, which the agent may never transact against. */
const RESOLVER = "0x7C66eE081c5326478dCA44760f5Ab97cab8DE8C3" as Address;

const account = privateKeyToAccount(AGENT_KEY);
// The runner's own client, not one built for the test. Anvil is started with
// Sepolia's chain id so this is the same object the supervisor uses in flight.
const publicClient = createRunnerClient(RPC);
const walletClient = createRunnerWallet(RPC, account);

let policy: SpendPolicy = parseSpendPolicy("", "");

const failures: string[] = [];
const log = { info: () => {}, warn: () => {} };

const broker = new WalletBroker({
  publicClient,
  walletClient,
  agent: account.address,
  port: PORT,
  serializer: new Serializer(),
  policy: () => policy,
  resolver: () => RESOLVER,
  ceiling: parseEther("0.05"),
  log,
});

type Answer = { status: number; body: Record<string, unknown> };

async function call(path: string, method: "GET" | "POST", body?: unknown): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${broker.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

let checked = 0;

const check = (name: string, ok: boolean, detail = "") => {
  checked += 1;
  if (ok) {
    console.log(`  ok    ${name}`);
    return;
  }
  console.log(`  FAIL  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  failures.push(name);
};

/** anvil's balance cheat code, so the reserve can be reached without a faucet. */
async function setBalance(address: Address, wei: bigint): Promise<void> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [address, `0x${wei.toString(16)}`],
    }),
  });
  const body = (await response.json()) as { error?: { message: string } };
  if (body.error !== undefined) throw new Error(`anvil_setBalance — ${body.error.message}`);
}

/** A refusal is a 403 whose reason mentions the thing that caused it. */
const refused = (name: string, answer: Answer, fragment: string) =>
  check(
    name,
    answer.status === 403 && String(answer.body.error ?? "").includes(fragment),
    `got ${answer.status} ${JSON.stringify(answer.body.error ?? answer.body)}`,
  );

async function main(): Promise<void> {
  try {
    await publicClient.getChainId();
  } catch {
    console.error(`no chain at ${RPC} — start one:\n  anvil --chain-id 11155111 --silent`);
    process.exit(1);
  }

  await broker.start();
  console.log(`wallet smoke · agent ${account.address} · broker ${broker.url}\n`);

  // -- the token is the door ----------------------------------------------
  const unauthorized = await fetch(`http://127.0.0.1:${PORT}/status`);
  check("no token is rejected", unauthorized.status === 401, `got ${unauthorized.status}`);

  const wrongToken = await fetch(`http://127.0.0.1:${PORT}/status`, {
    headers: { authorization: "Bearer not-the-token" },
  });
  check("a wrong token is rejected", wrongToken.status === 401, `got ${wrongToken.status}`);

  // -- spending is off until an owner turns it on -------------------------
  const offStatus = await call("/status", "GET");
  check("status reports spending off", offStatus.body.enabled === false, JSON.stringify(offStatus.body));

  refused(
    "a send with no agent-spend-cap is refused",
    await call("/send", "POST", { to: RECIPIENT, value: "0.001" }),
    "agent-spend-cap",
  );

  // -- the owner writes a cap. Nothing restarts. --------------------------
  policy = parseSpendPolicy("0.01", "");
  const onStatus = await call("/status", "GET");
  check("the new cap is live with no restart", onStatus.body.enabled === true, JSON.stringify(onStatus.body));
  check("status reports the cap", onStatus.body.capEth === "0.01", String(onStatus.body.capEth));

  // -- a transfer inside the cap actually lands ---------------------------
  const before = await publicClient.getBalance({ address: RECIPIENT });
  const sent = await call("/send", "POST", { to: RECIPIENT, value: "0.005", note: "smoke" });
  check("a send within the cap succeeds", sent.status === 200 && sent.body.ok === true, JSON.stringify(sent.body));
  const after = await publicClient.getBalance({ address: RECIPIENT });
  check(
    "the recipient was actually paid",
    after - before === parseEther("0.005"),
    `moved ${formatEther(after - before)} ETH`,
  );
  check("the run total moved", sent.body.spentThisRunEth === "0.005", String(sent.body.spentThisRunEth));

  // -- the cap is a cap ---------------------------------------------------
  refused(
    "over the cap is refused",
    await call("/send", "POST", { to: RECIPIENT, value: "0.02" }),
    "per-transaction cap",
  );

  // -- the resolver is never a destination --------------------------------
  refused(
    "the capsule's own resolver is refused",
    await call("/send", "POST", { to: RESOLVER, value: "0.001" }),
    "resolver",
  );

  // -- contract calls need the target named -------------------------------
  refused(
    'calldata is refused while the allowlist is "any"',
    await call("/call", "POST", { to: RECIPIENT, data: "0xa9059cbb", value: "0" }),
    "agent-spend-allow",
  );

  // -- the allowlist narrows ----------------------------------------------
  policy = parseSpendPolicy("0.01", RECIPIENT);
  refused(
    "an address off the allowlist is refused",
    await call("/send", "POST", { to: STRANGER, value: "0.001" }),
    "agent-spend-allow",
  );
  const allowed = await call("/send", "POST", { to: RECIPIENT, value: "0.001" });
  check("an address on the allowlist is allowed", allowed.status === 200, JSON.stringify(allowed.body));

  // -- the per-run ceiling stops a loop -----------------------------------
  policy = parseSpendPolicy("0.05", "");
  const ceilingHit = await call("/send", "POST", { to: RECIPIENT, value: "0.05" });
  refused("the per-run ceiling stops a loop", ceilingHit, "ceiling");

  // -- a malformed cap fails closed, and says so --------------------------
  const junk = parseSpendPolicy("0,01", "");
  check("a malformed cap parses to zero", junk.cap === 0n, String(junk.cap));
  check("and reports why", junk.problems.length === 1, junk.problems.join("; "));

  const absurd = parseSpendPolicy("1000", "");
  check("a cap above the sanity ceiling is refused", absurd.cap === 0n, String(absurd.cap));

  const emptyAllow = parseSpendPolicy("0.01", "not-an-address");
  check(
    "an unreadable allowlist allows nothing",
    Array.isArray(emptyAllow.allow) && emptyAllow.allow.length === 0,
    JSON.stringify(emptyAllow.allow),
  );

  // -- the gas reserve is the last line -----------------------------------
  //
  // The reserve is ~50 beats of gas, which at anvil's gas price is a few
  // thousandths of an ETH — unreachable from a default account holding ten
  // thousand. So the account is drained to just above it and asked for a
  // transfer the cap plainly allows. The refusal has to come from the reserve,
  // which is the one check that is not about permission at all.
  //
  // This is the case that protects the whole thesis: an agent that could spend
  // its last wei would stop beating, and a capsule that has stopped beating is
  // indistinguishable on chain from one that was recalled.
  const drained = parseEther("0.002");
  await setBalance(account.address, drained);
  policy = parseSpendPolicy("0.01", "");
  const reserveHit = await call("/send", "POST", { to: RECIPIENT, value: "0.001" });
  check(
    "the heartbeat reserve is held back",
    reserveHit.status === 403 && String(reserveHit.body.error ?? "").includes("heartbeat"),
    `got ${reserveHit.status} ${JSON.stringify(reserveHit.body.error ?? "")}`,
  );

  const brokeStatus = await call("/status", "GET");
  check(
    "status reports nothing spendable once the reserve bites",
    brokeStatus.body.spendableEth === "0",
    String(brokeStatus.body.spendableEth),
  );

  // Topped up again: a reserve refusal must be a top-up, never a redeploy.
  await setBalance(account.address, parseEther("1"));
  const afterTopUp = await call("/send", "POST", { to: RECIPIENT, value: "0.001" });
  check("a top-up restores spending", afterTopUp.status === 200, JSON.stringify(afterTopUp.body.error ?? ""));

  // -- two writers, one nonce ---------------------------------------------
  //
  // The failure this catches does not reproduce without concurrency: viem reads
  // the pending nonce at send time, so two overlapping sends read the same one
  // and the chain keeps one of them. Five at once through the shared queue must
  // all land.
  policy = parseSpendPolicy("0.01", "");
  const concurrent = await Promise.all(
    [1, 2, 3, 4, 5].map(() => call("/send", "POST", { to: RECIPIENT, value: "0.0001" })),
  );
  const landed = concurrent.filter((answer) => answer.status === 200 && answer.body.ok === true).length;
  check(
    "five concurrent sends all land on their own nonce",
    landed === 5,
    `${landed}/5 landed: ${concurrent.map((a) => a.body.error ?? "ok").join(" · ")}`,
  );

  await broker.stop();

  console.log(
    failures.length === 0
      ? `\nwallet broker holds the line (${checked} checks)`
      : `\n${failures.length} FAILED: ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
