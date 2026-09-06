/**
 * Preflight — every boring reason the runner could fail, caught at boot.
 *
 * The runner is meant to die exactly once, for exactly one reason: its write
 * permission on `agent.heartbeat` was revoked. Anything else that can stop it —
 * a wrong network, an empty wallet, the wrong key — has to be ruled out here,
 * or a revoked agent and a misconfigured agent look identical on camera.
 *
 * Exits 0 with every check passing, 1 otherwise. Nothing else.
 */
import "dotenv/config";
import { formatEther, isAddressEqual, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN, createRunnerClient } from "./chain.js";
import { InvalidEnvError, MissingEnvError, loadEnv } from "./env.js";

/**
 * Informational only. The runner probes its authorization with eth_call and
 * never sends a transaction, so an agent with an empty wallet is fine — the
 * balance matters only for the manual `npm run heartbeat` tool.
 */
const NOTABLE_GAS = parseEther("0.002");

type Check = { label: string; ok: boolean; detail: string };

const short = (address: string) => `${address.slice(0, 10)}…${address.slice(-6)}`;
const eth = (wei: bigint) => `${Number(formatEther(wei)).toFixed(6)} ETH`;
const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

function fail(line: string): never {
  console.error(line);
  console.error("preflight failed");
  process.exit(1);
}

async function main() {
  // Config first: there is no point dialling an RPC we may not have been given.
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof MissingEnvError || error instanceof InvalidEnvError) {
      fail(`❌ env       ${error.message}`);
    }
    throw error;
  }

  const checks: Check[] = [];
  const client = createRunnerClient(env.rpcUrl);

  // 1 + 2 — the chain is reachable, and it is the chain we think it is.
  let chainId: number | undefined;
  try {
    const [id, block] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
    chainId = id;
    checks.push({ label: "rpc", ok: true, detail: `block ${block}` });
  } catch (error) {
    checks.push({ label: "rpc", ok: false, detail: `unreachable — ${why(error)}` });
  }

  const onSepolia = chainId === CHAIN.id;
  checks.push({
    label: "chain",
    ok: onSepolia,
    detail:
      chainId === undefined
        ? "not checked — RPC unreachable"
        : onSepolia
          ? `${chainId} (sepolia)`
          : `${chainId} — expected ${CHAIN.id} (sepolia)`,
  });

  // 3 — the key we hold is the agent's key.
  //
  // AGENT_KEY and AGENT_ADDRESS are two independent values and nothing forces
  // them to agree. If they drift, the runner resolves records for one identity
  // and signs as another, and the resolver's revert cannot tell you so: it
  // reports the name-level resource, never the key or the account at fault.
  const account = privateKeyToAccount(env.agentKey);
  const identityOk = isAddressEqual(account.address, env.agentAddress);
  checks.push({
    label: "identity",
    ok: identityOk,
    detail: identityOk
      ? short(account.address)
      : `${short(account.address)} ≠ AGENT_ADDRESS ${short(env.agentAddress)}`,
  });

  // 4 — balance, for information. Not a gate: see NOTABLE_GAS above.
  let gasNote = "not checked — wrong or unreachable chain";
  if (onSepolia) {
    try {
      const balance = await client.getBalance({ address: account.address });
      gasNote =
        balance >= NOTABLE_GAS
          ? `${eth(balance)} — enough for manual writes`
          : `${eth(balance)} — read-only operation unaffected`;
    } catch (error) {
      gasNote = `balance unreadable — ${why(error)}`;
    }
  }

  // Print every result, passing or not: fixing one variable at a time, four
  // times over, is its own kind of 2am.
  console.log(`   capsule   ${env.capsuleName}`);
  console.log(`   gas       ${gasNote}`);
  for (const check of checks) {
    console.log(`${check.ok ? "✅" : "❌"} ${check.label.padEnd(9)} ${check.detail}`);
  }

  if (checks.some((check) => !check.ok)) {
    console.error("preflight failed");
    process.exit(1);
  }
  console.log("preflight passed");
}

main().catch((error) => {
  console.error(`❌ preflight crashed — ${why(error)}`);
  process.exit(1);
});
