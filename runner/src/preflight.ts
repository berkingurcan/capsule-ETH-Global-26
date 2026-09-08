/**
 * Preflight — every boring reason the runner could fail, caught at boot.
 *
 * The runner is meant to die exactly once, for exactly one reason: its write
 * permission on `agent-heartbeat` was revoked. Anything else that can stop it —
 * a wrong network, an empty wallet, the wrong key — has to be ruled out here,
 * or a revoked agent and a misconfigured agent look identical on camera.
 *
 * Exits 0 with every check passing, 1 otherwise. Nothing else.
 */
import "dotenv/config";
import { formatEther, formatGwei, isAddressEqual } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN, createRunnerClient } from "./chain.js";
import { InvalidEnvError, MissingEnvError, loadEnv } from "./env.js";
import { LOW_BEATS, readFunding } from "./heartbeat.js";

type Check = { label: string; ok: boolean; detail: string };

const short = (address: string) => `${address.slice(0, 10)}…${address.slice(-6)}`;
const eth = (wei: bigint) => `${Number(formatEther(wei)).toFixed(6)} ETH`;
const gwei = (wei: bigint) => `${Number(formatGwei(wei)).toFixed(2)} gwei`;
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

    // 4 — can it pay for its own heartbeat?
    //
    // This became a real check when the heartbeat became a real transaction. An
    // agent that cannot afford one write never writes one, and on a dashboard a
    // heartbeat that never advances is indistinguishable from a revoked agent —
    // which is the single confusion this whole file exists to prevent.
    //
    // Zero affordable beats fails; merely low warns. The runner survives an
    // empty wallet by design, degrading to probe-only, so "low" is a thing to
    // fix rather than a reason to refuse to start.
    if (!onSepolia) {
        // The rpc and chain checks have already failed; adding a third failure
        // for the same cause buries the one that can be acted on.
        checks.push({ label: "gas", ok: true, detail: "not checked — wrong or unreachable chain" });
    } else {
        try {
            const { balance, gasPrice, beats, low } = await readFunding(client, account.address);
            const body = `${eth(balance)} · ~${beats.toLocaleString("en-US")} beats at ${gwei(gasPrice)}`;
            checks.push({
                label: "gas",
                ok: beats > 0,
                detail:
                    beats === 0
                        ? `${body} — cannot afford a single heartbeat. Fund ${short(account.address)}`
                        : low
                            ? `${body} — under ${LOW_BEATS}, top it up`
                            : body,
            });
        } catch (error) {
            // Unreadable is not the same as empty, and failing the run on a
            // guess would be worse than saying which one we could not tell.
            checks.push({ label: "gas", ok: true, detail: `balance unreadable — ${why(error)}` });
        }
    }

    // Print every result, passing or not: fixing one variable at a time, four
    // times over, is its own kind of 2am.
    console.log(`   capsule   ${env.capsuleName}`);
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