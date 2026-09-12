/**
 * The spending cap, from the form to the chain.
 *
 * `check-records.ts` proves the web and the runner agree about the key and the
 * ceiling. This proves the other half: that the value this app writes is one
 * the runner will actually honour, and that the write itself works.
 *
 * Two things are being guarded, and only one of them is arithmetic.
 *
 *   the validators   `agent-spend-cap` is a decimal ETH string, and the runner
 *                    fails closed on anything it cannot parse — so a form that
 *                    accepts "0,01" lets an owner pay gas to write a record
 *                    that silently means zero. The boundary cases are the
 *                    point: the ceiling exactly, one wei over it, and the
 *                    difference between "0" and "".
 *
 *   the transaction  simulate -> sign -> mine -> receipt, against a real chain.
 *                    A stand-in resolver is deployed rather than mocked,
 *                    because what is being checked is the ABI encoding and the
 *                    receipt handling, and a mock of those proves nothing.
 *
 * Needs a local chain and spends nothing real:
 *
 *   anvil --chain-id 11155111 --silent &
 *   npm run check:spend
 *
 * The validators run offline either way. Only the transaction half is skipped
 * when no chain is listening, so this can sit in a checklist beside the offline
 * guards without failing a checkout that only wants to build the web app.
 */
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  MAX_SPEND_CAP_ETH,
  SpendCapError,
  setSpendCap,
  spendCapEnables,
  spendCapProblems,
} from "../lib/capsule/spend";

const RPC = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8545";

/** anvil's first default account. Public, deterministic, worthless. */
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

let fails = 0;
let checked = 0;

const ok = (name: string, cond: boolean, detail = "") => {
  checked += 1;
  console.log(cond ? `  ok    ${name}` : `  FAIL  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  if (!cond) fails += 1;
};

/** Whether anything is listening, without making the caller wait on a timeout. */
async function chainIsUp(): Promise<boolean> {
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function checkValidators(): void {
  ok("empty is not a problem (it is the default)", spendCapProblems("").length === 0);
  ok("whitespace is not a problem", spendCapProblems("   ").length === 0);
  ok('"0.01" is accepted', spendCapProblems("0.01").length === 0);
  ok('"0" is accepted but does not enable', spendCapProblems("0").length === 0 && !spendCapEnables("0"));
  ok('"0,01" is rejected', spendCapProblems("0,01").length === 1, spendCapProblems("0,01").join("; "));
  ok('"abc" is rejected', spendCapProblems("abc").length === 1);
  ok(`"${MAX_SPEND_CAP_ETH}" is exactly at the ceiling`, spendCapProblems(MAX_SPEND_CAP_ETH).length === 0);
  ok("one wei over the ceiling is rejected", spendCapProblems("10.000000000000000001").length === 1);
  ok('"1000" is rejected as a typo', spendCapProblems("1000").length === 1);
  ok('"0.01" enables spending', spendCapEnables("0.01"));
  ok("empty does not enable spending", !spendCapEnables(""));
  ok("a malformed value never enables spending", !spendCapEnables("0,01"));
}

async function checkTransaction(): Promise<void> {
  const account = privateKeyToAccount(KEY);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(RPC) });

  /** Deploys runtime code and hands back where it landed. */
  const deploy = async (initCode: Hex) => {
    const hash = await walletClient.sendTransaction({ data: initCode });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.contractAddress!;
  };

  // Runtime `0x00` — STOP. Accepts any call, returns nothing, which is exactly
  // the shape of `setText(bytes32,string,string)`.
  //
  // It also answers `getRecordCount()` with nothing, which fails to decode as a
  // uint256 — so `setSpendCap` probes this as the beta revision and takes the
  // namehash branch, which is the one being checked below.
  const resolver = await deploy("0x600060005360016000f3");

  const node = `0x${"ab".repeat(32)}` as Hex;
  const name = "trader.capsulefleet.eth";
  const phases: string[] = [];
  const receipt = await setSpendCap(
    { walletClient, publicClient, resolver, node, name, cap: " 0.003 " },
    (phase) => phases.push(phase),
  );

  ok("setSpendCap lands a real transaction", receipt.hash.startsWith("0x") && receipt.blockNumber > 0n);
  // The launchpad passes whatever is in the input. A stray space written into
  // the record is a cap the runner's parser rejects, and rejecting means zero.
  ok("it trims the value it writes", receipt.cap === "0.003", receipt.cap);
  ok("it reports every phase in order", phases.join(" > ") === "simulating > signing > mining", phases.join(" > "));

  // Runtime `0xfe` — INVALID. Stands in for a resolver that refuses the write,
  // which in production is the role check. What matters is that it reaches the
  // caller as a sentence rather than as a nested viem dump.
  const refuses = await deploy("0x60fe60005360016000f3");
  try {
    await setSpendCap({ walletClient, publicClient, resolver: refuses, node, name, cap: "0.003" });
    ok("a refusing resolver is reported", false, "no error was thrown");
  } catch (error) {
    ok("a refusing resolver is reported as a SpendCapError", error instanceof SpendCapError, String(error).slice(0, 90));
  }
}

async function main(): Promise<void> {
  checkValidators();

  if (await chainIsUp()) {
    await checkTransaction();
  } else {
    console.log(`\n  skipped the transaction half — no chain at ${RPC}`);
    console.log("  start one with: anvil --chain-id 11155111 --silent");
  }

  console.log(
    fails === 0
      ? `\nthe spending cap this app writes is one the runner honours (${checked} checks)`
      : `\n${fails} FAILED`,
  );
  process.exit(fails === 0 ? 0 : 1);
}

void main();
