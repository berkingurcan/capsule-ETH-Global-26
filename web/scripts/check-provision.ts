/**
 * Proves the provision path without provisioning anything.
 *
 * The route spends two irreversible things — ETH out of the funder wallet and a
 * machine in the Fly app — so unlike `check:mint` there is no `eth_call`
 * equivalent that exercises the whole thing for free. What there is instead is a
 * clean split: everything that decides *whether* to spend is checkable, and the
 * spending itself is one Fly call whose shape can be proved by creating a
 * machine and destroying it again.
 *
 * So this checks, in order:
 *
 *   1. **The runner's environment contract.** `runnerEnvironment` IS the
 *      deployment — the image has no config file. Every `requireEnv` in
 *      runner/src/env.ts is read out of the runner source as text and asserted
 *      present here. A variable renamed on one side is otherwise a container
 *      that exits on its first line, hours later, in a log nobody is reading.
 *   2. **The environment loader's refusals**, including the memory floor that
 *      exists because 512 MB OOMs silently (GATE-LOG.md).
 *   3. **The chain reads the authorisation rests on** — `REGISTRY()`,
 *      `findOwner` on a minted name and on a free one, `addr` and `agent-model`.
 *   4. **Fly**, read-only: the token can list machines, and a capsule with no
 *      machine reports none.
 *   5. **Every refusal the live route makes**, against a running server. These
 *      are the checks that matter most and they cost nothing: a valid signature
 *      from someone who is not the owner must not start a machine.
 *
 * Two things are opt-in because they cost something:
 *
 *     CAPSULE_CHECK_FLY_CREATE=1   create a machine with the real config and
 *                                  destroy it — proves Fly accepts the shape
 *                                  and that RUNNER_IMAGE exists
 *
 * Run with:  npm run check:provision
 */
import { createPublicClient, http, zeroAddress, type Address } from "viem";
import { sepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { minterAbi, registryAbi } from "../lib/capsule/chain";
import { loadProvisionerEnv, loadServerEnv, InvalidEnvError, MissingEnvError } from "../lib/capsule/env";
import {
  createMachine,
  destroyMachine,
  findCapsuleMachine,
  listMachines,
  MACHINE_CAPSULE_NAME,
  type FlyConfig,
} from "../lib/capsule/fly";
import { parseModelRef } from "../lib/capsule/providers";
import {
  machineMetadata,
  machineNameFor,
  parseProvisionRequest,
  runnerEnvironment,
} from "../lib/capsule/provision";
import { provisionCapsuleRequest, ProvisionError } from "../lib/capsule/provision-client";
import { readIdentity } from "../lib/capsule/resolve";
import { HEADER_SIGNATURE, HEADER_TIMESTAMP, provisionMessage } from "../lib/capsule/wire";

const BASE = process.env.CAPSULE_CHECK_BASE_URL ?? "http://localhost:3000";

/** A label nobody will ever mint, used wherever "free name" is the fixture. */
const FREE_LABEL = `checkprov${Math.random().toString(36).slice(2, 8)}`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** Runs a loader with one variable overridden, and reports what it threw. */
function envRefusal(overrides: Record<string, string | undefined>): string | null {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    loadProvisionerEnv();
    return null;
  } catch (error) {
    return error instanceof MissingEnvError || error instanceof InvalidEnvError
      ? error.varName
      : `«${error instanceof Error ? error.name : "?"}»`;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main() {
  const env = loadServerEnv();
  const client = createPublicClient({ chain: sepolia, transport: http(env.rpcUrl, { batch: true }) });

  console.log(`app ${env.flyAppName} · image ${env.runnerImage} · region ${env.flyRegion}\n`);

  // --- 1. the runner's environment contract --------------------------------
  //
  // Read out of the runner source rather than restated, for the same reason
  // check:wire reads the prompt contract there: this is a copied interface
  // between two programs that cannot import each other, and the failure is late
  // and quiet.
  const runnerSource = readFileSync(new URL("../../runner/src/env.ts", import.meta.url), "utf8");
  const required = [...runnerSource.matchAll(/requireEnv\("([A-Z_]+)"\)/g)].map((m) => m[1]!);

  const machineEnv = runnerEnvironment({
    rpcUrl: "https://rpc.example",
    capsuleName: "analyst.capsulefleet.eth",
    agentAddress: "0xca266f69EE3EFed7eC71CE5062f5A07c18908905",
    agentPrivateKey: `0x${"11".repeat(32)}`,
    tickSeconds: 30,
    heartbeatSeconds: 28800,
  });

  check(
    "found the runner's required variables",
    required.length >= 4,
    `${required.length} in runner/src/env.ts: ${required.join(" ")}`,
  );
  for (const name of required) {
    check(`  the machine is given ${name}`, machineEnv[name] !== undefined && machineEnv[name] !== "");
  }

  // Both of these have runner-side defaults, which is exactly why they are set
  // explicitly: a default that drifts on one side is a cadence change nobody
  // decided, and one of them costs gas.
  for (const name of ["TICK_SECONDS", "HEARTBEAT_SECONDS"]) {
    check(`  the machine is given ${name} explicitly`, machineEnv[name] !== undefined, machineEnv[name]);
  }

  check(
    "  CAPSULE_ENDPOINT_OVERRIDE is not set",
    machineEnv.CAPSULE_ENDPOINT_OVERRIDE === undefined,
    "a deployed capsule must read agent-endpoint[capsule] off its own name",
  );
  check(
    "  the runner is given nothing else",
    Object.keys(machineEnv).length === required.length + 2,
    Object.keys(machineEnv).join(" "),
  );

  // --- 2. the request and the names it builds -------------------------------
  const good = parseProvisionRequest({ label: "analyst" }, env.parentName);
  check(
    "\na valid label parses to the capsule name",
    good.ok && good.capsuleName === `analyst.${env.parentName}`,
    good.ok ? good.capsuleName : JSON.stringify(good.problems),
  );
  check("  an uppercase label is refused", !parseProvisionRequest({ label: "Analyst" }, env.parentName).ok);
  check("  an empty label is refused", !parseProvisionRequest({ label: "" }, env.parentName).ok);
  check("  a label with a dot is refused", !parseProvisionRequest({ label: "a.b" }, env.parentName).ok);
  check("  a non-object body is refused", !parseProvisionRequest("analyst", env.parentName).ok);

  const longName = machineNameFor("a".repeat(63));
  check("  the machine name stays inside Fly's 63 characters", longName.length <= 63, `${longName.length}`);
  check(
    "  the metadata carries the key findCapsuleMachine matches on",
    machineMetadata({ capsuleName: "Analyst.Capsulefleet.eth", agentAddress: zeroAddress })[
      MACHINE_CAPSULE_NAME
    ] === "analyst.capsulefleet.eth",
  );

  // --- 3. the loader's refusals ---------------------------------------------
  const configured = process.env.CAPSULE_FUNDER_KEY !== undefined && process.env.CAPSULE_FUNDER_KEY !== "";
  if (!configured) {
    console.log("\n  skip  provisioner env — CAPSULE_FUNDER_KEY is not set (the route would answer 503)");
  } else {
    let provisioner;
    try {
      provisioner = loadProvisionerEnv();
      check("\nthe provisioner env loads", true, `funder ${provisioner.funderAddress}`);
    } catch (error) {
      check("\nthe provisioner env loads", false, String(error));
    }

    check(
      "  a missing funder key is refused",
      envRefusal({ CAPSULE_FUNDER_KEY: undefined }) === "CAPSULE_FUNDER_KEY",
    );
    check(
      "  a short funder key is refused",
      envRefusal({ CAPSULE_FUNDER_KEY: "0xdeadbeef" }) === "CAPSULE_FUNDER_KEY",
    );
    check(
      "  512 MB is refused",
      envRefusal({ FLY_MACHINE_MEMORY_MB: "512" }) === "FLY_MACHINE_MEMORY_MB",
      "842 MiB measured; the OOM looks like a clean boot",
    );
    check("  1024 MB is allowed", envRefusal({ FLY_MACHINE_MEMORY_MB: "1024" }) === null);
    check(
      "  zero funding is refused",
      envRefusal({ CAPSULE_AGENT_FUNDING_ETH: "0" }) === "CAPSULE_AGENT_FUNDING_ETH",
      "an agent with no gas cannot beat, and a beat that fails for gas looks like a recall",
    );
    check(
      "  a heartbeat faster than the tick is refused",
      envRefusal({ CAPSULE_TICK_SECONDS: "30", CAPSULE_HEARTBEAT_SECONDS: "10" }) ===
        "CAPSULE_HEARTBEAT_SECONDS",
    );

    if (provisioner !== undefined) {
      const balance = await client.getBalance({ address: provisioner.funderAddress });
      const capsules = balance / provisioner.agentFundingWei;
      check(
        "  the funder can pay for at least one capsule",
        balance >= provisioner.agentFundingWei,
        `${balance} wei · ${capsules} capsule(s) at the configured amount`,
      );
    }
  }

  // --- 4. the chain the authorisation rests on ------------------------------
  const registry = await client.readContract({
    address: env.minterAddress,
    abi: minterAbi,
    functionName: "REGISTRY",
  });
  check("\nthe minter names its registry", registry !== zeroAddress, registry);

  const freeOwner = await client.readContract({
    address: registry,
    abi: registryAbi,
    functionName: "findOwner",
    args: [FREE_LABEL],
  });
  check("  an unminted label has no owner", freeOwner === zeroAddress, `${FREE_LABEL} → ${freeOwner}`);

  // A real capsule, whichever one this deployment has. Read rather than named,
  // so the check does not rot when the fixture is re-minted.
  const minted = await client.getLogs({
    address: env.minterAddress,
    event: minterAbi.find((i) => i.type === "event" && i.name === "CapsuleMinted") as never,
    fromBlock: env.minterBlock,
    toBlock: "latest",
  });
  const sample = (minted.at(-1) as { args?: { label?: string; owner?: Address } } | undefined)?.args;

  if (sample?.label === undefined) {
    console.log("  skip  no CapsuleMinted logs — nothing minted under this deployment yet");
  } else {
    const label = sample.label;
    const owner = await client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "findOwner",
      args: [label],
    });
    check(`  ${label} has a current owner`, owner !== zeroAddress, owner);
    check(
      "  findOwner agrees with the mint log",
      owner.toLowerCase() === (sample.owner ?? zeroAddress).toLowerCase(),
      "a transfer would legitimately break this — findOwner is the one the route trusts",
    );

    const identity = await readIdentity(client, `${label}.${env.parentName}`);
    check("  it publishes an agent in addr", identity.address !== zeroAddress, identity.address);
    check(
      "  its agent-model is one the runner can boot",
      parseModelRef(identity.model) !== null,
      identity.model,
    );
  }

  // --- 5. Fly, read-only ----------------------------------------------------
  const fly: FlyConfig = { token: env.flyApiToken, appName: env.flyAppName };
  const machines = await listMachines(fly);
  check("\nthe Fly token can list machines", true, `${machines.length} in ${env.flyAppName}`);
  check(
    "  a capsule with no machine reports none",
    (await findCapsuleMachine(fly, `${FREE_LABEL}.${env.parentName}`)) === null,
  );

  // --- 6. the config Fly actually accepts -----------------------------------
  if (process.env.CAPSULE_CHECK_FLY_CREATE !== "1") {
    console.log("\n  skip  machine create — set CAPSULE_CHECK_FLY_CREATE=1 to create one and destroy it");
  } else {
    const capsuleName = `${FREE_LABEL}.${env.parentName}`;
    let created;
    try {
      created = await createMachine(fly, {
        name: machineNameFor(FREE_LABEL),
        region: env.flyRegion,
        image: env.runnerImage,
        // A key that owns nothing, a name that does not exist. The runner will
        // start, fail to resolve, and be destroyed before it finishes trying.
        env: runnerEnvironment({
          rpcUrl: env.rpcUrl,
          capsuleName,
          agentAddress: privateKeyToAccount(generatePrivateKey()).address,
          agentPrivateKey: generatePrivateKey(),
          tickSeconds: 30,
          heartbeatSeconds: 28800,
        }),
        memoryMb: configured ? loadProvisionerEnv().machineMemoryMb : 2048,
        metadata: machineMetadata({ capsuleName, agentAddress: zeroAddress }),
      });
      check("\nFly accepts the machine config", true, `${created.id} · ${created.state}`);
      check(
        "  and findCapsuleMachine finds it by metadata",
        (await findCapsuleMachine(fly, capsuleName))?.id === created.id,
      );
    } catch (error) {
      check("\nFly accepts the machine config", false, String(error).split("\n")[0]);
    } finally {
      if (created !== undefined) {
        await destroyMachine(fly, created.id);
        check(
          "  cleaned up the machine it created",
          (await findCapsuleMachine(fly, capsuleName)) === null,
          created.id,
        );
      }
    }
  }

  // --- 7. the live route's refusals -----------------------------------------
  //
  // Every one of these is a request that must NOT spend. They are the reason the
  // route exists in the shape it does, and none of them costs anything to check.
  const reachable = await fetch(`${BASE}/api/health`)
    .then((r) => r.ok)
    .catch(() => false);

  if (!reachable) {
    console.log(`\n  skip  live refusals — nothing answering at ${BASE} (start the app to check them)`);
  } else {
    const stranger = privateKeyToAccount(generatePrivateKey());

    const status = async (
      body: string,
      headers: Record<string, string>,
    ): Promise<{ code: number; error: string }> => {
      const response = await fetch(`${BASE}/api/capsule/provision`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
      const json = (await response.json().catch(() => ({}))) as { error?: string };
      return { code: response.status, error: json.error ?? "" };
    };

    const sign = async (capsuleName: string, timestamp: number) =>
      stranger.signMessage({ message: provisionMessage(capsuleName, timestamp) });

    const now = Math.floor(Date.now() / 1000);

    check(
      "\nno headers is refused",
      (await status(JSON.stringify({ label: "analyst" }), {})).code === 400,
    );
    check(
      "  an unparseable body is refused",
      (
        await status("{", {
          [HEADER_TIMESTAMP]: String(now),
          [HEADER_SIGNATURE]: await sign(`x.${env.parentName}`, now),
        })
      ).code === 400,
    );
    check(
      "  a bad label is refused before anything is read",
      (
        await status(JSON.stringify({ label: "NOT A LABEL" }), {
          [HEADER_TIMESTAMP]: String(now),
          [HEADER_SIGNATURE]: await sign(`x.${env.parentName}`, now),
        })
      ).code === 422,
    );
    check(
      "  a stale timestamp is refused",
      (
        await status(JSON.stringify({ label: FREE_LABEL }), {
          [HEADER_TIMESTAMP]: String(now - 3600),
          [HEADER_SIGNATURE]: await sign(`${FREE_LABEL}.${env.parentName}`, now - 3600),
        })
      ).code === 403,
    );
    check(
      "  a signature that does not recover is refused",
      (
        await status(JSON.stringify({ label: FREE_LABEL }), {
          [HEADER_TIMESTAMP]: String(now),
          [HEADER_SIGNATURE]: `0x${"00".repeat(65)}`,
        })
      ).code === 403,
    );

    const unminted = await status(JSON.stringify({ label: FREE_LABEL }), {
      [HEADER_TIMESTAMP]: String(now),
      [HEADER_SIGNATURE]: await sign(`${FREE_LABEL}.${env.parentName}`, now),
    });
    check("  an unminted name is refused", unminted.code === 404, unminted.error);

    // The one that matters. A perfectly valid signature, a real minted capsule,
    // and a signer who does not own it. If this ever returns 200, anyone can
    // spend the funder wallet dry by provisioning names they do not hold.
    if (sample?.label !== undefined) {
      const notOwner = await status(JSON.stringify({ label: sample.label }), {
        [HEADER_TIMESTAMP]: String(now),
        [HEADER_SIGNATURE]: await sign(`${sample.label}.${env.parentName}`, now),
      });
      check(
        "  a valid signature from someone who is not the owner is refused",
        notOwner.code === 403,
        `${notOwner.code} ${notOwner.error}`,
      );

      // And the same request signed for a *different* name than the body names:
      // the label decides what gets provisioned, so the signature has to cover
      // it or one signature would work on every capsule the signer owns.
      const wrongName = await status(JSON.stringify({ label: sample.label }), {
        [HEADER_TIMESTAMP]: String(now),
        [HEADER_SIGNATURE]: await sign(`somethingelse.${env.parentName}`, now),
      });
      check(
        "  a signature for a different name does not authorise this one",
        wrongName.code === 403,
        `${wrongName.code} ${wrongName.error}`,
      );
    }

    // The client module produces the same refusal as the raw request above,
    // which is what proves the launchpad is signing what the route verifies.
    try {
      await provisionCapsuleRequest(
        { label: FREE_LABEL, capsuleName: `${FREE_LABEL}.${env.parentName}` },
        (args) => stranger.signMessage({ message: args.message }),
        { baseUrl: BASE },
      );
      check("  the browser client reaches the same refusal", false, "it was accepted");
    } catch (error) {
      check(
        "  the browser client reaches the same refusal",
        error instanceof ProvisionError && error.failure.status === 404,
        error instanceof ProvisionError ? `${error.failure.status} ${error.failure.error}` : String(error),
      );
    }
  }

  console.log(
    failures === 0
      ? "\nprovision path OK — the spending itself is proved by starting a capsule from the launchpad"
      : `\n${failures} check(s) failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
