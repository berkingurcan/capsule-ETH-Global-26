/**
 * Proves the browser mint path against the live minter, without spending gas.
 *
 * `eth_call` runs the real `mint()` against real state and reverts for the real
 * reasons, so everything the launchpad's mint step depends on can be checked
 * here — the ABI, the argument order, the revert decoding and the event parsing
 * — with no transaction and no funded account.
 *
 * What this catches that a passing build does not:
 *
 *   1. **The config tuple order.** viem encodes a struct positionally. Swap two
 *      fields in `minterAbi` and every mint still succeeds, writing the Telegram
 *      URL into `agent-context`. Nothing fails; the records are just wrong. So
 *      the ABI's field order is asserted against the struct in CapsuleMinter.sol.
 *   2. **`CapsuleMinted` decoding.** `mintCapsule` refuses to report a mint it
 *      cannot read the event for, so a wrong event signature would turn every
 *      successful mint into an error. Checked against a real historic log.
 *   3. **The reverts the UI names.** `InvalidLabel` and `ZeroAddress` are
 *      rendered as sentences; if the errors are not in the ABI they decode to a
 *      bare selector and the user is told nothing.
 *   4. **`checkResolverRoles()`** — the precondition step 01 reads, and the one
 *      that can be revoked out from under this deployment at any time.
 *
 * Run with:  npm run check:mint
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
  zeroAddress,
  type Address,
} from "viem";
import { sepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";
import { minterAbi } from "../lib/capsule/chain";
import { loadServerEnv } from "../lib/capsule/env";
import { encodeName } from "../lib/capsule/resolve";
import { buildMintParams, capsuleMintedFrom, minterCanWrite } from "../lib/capsule/mint";
import { prepareCapsuleRequest, type PrepareResult } from "../lib/capsule/prepare-client";

/** Where the running app is. The seam section skips if nothing answers. */
const BASE = process.env.CAPSULE_CHECK_BASE_URL ?? "http://localhost:3000";

/** Every row this script writes is named with it, so cleanup is one statement. */
const SEAM_LABEL = "checkmint";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** The error name a simulated call reverted with, or null if it did not revert. */
function revertNameOf(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return "«undecoded»";
  return reverted.data?.errorName ?? "«unnamed»";
}

/** A prepare response shaped like the real one, with values we can recognise. */
function fakePrepared(label: string, owner: Address, agent: Address): PrepareResult {
  return {
    capsuleName: `${label}.example.eth`,
    label,
    owner,
    agent,
    promptRef: "cap_check0",
    config: {
      context: "CHECK-context",
      telegramUrl: "https://t.me/checkbot",
      capsuleEndpoint: "https://check.invalid",
      model: "anthropic/claude-opus-5",
      runtime: "openclaw",
      promptPointer: "cap_check0",
    },
  };
}

async function main() {
  const env = loadServerEnv();
  const client = createPublicClient({ chain: sepolia, transport: http(env.rpcUrl, { batch: true }) });
  const minter = env.minterAddress;

  console.log(`minter ${minter} on ${sepolia.name}\n`);

  // --- 1. the struct order, read off the Solidity ---------------------------
  //
  // The one bug in this file that no runtime check can find, because both
  // orders encode and both mints succeed.
  const source = readFileSync(new URL("../../contracts/src/CapsuleMinter.sol", import.meta.url), "utf8");
  const structBody = /struct\s+CapsuleConfig\s*\{([^}]*)\}/.exec(source)?.[1] ?? "";
  const solidityFields = [...structBody.matchAll(/^\s*string\s+(\w+);/gm)].map((m) => m[1]!);

  const mintInput = minterAbi.find((item) => item.type === "function" && item.name === "mint");
  const configArg =
    mintInput !== undefined && "inputs" in mintInput ? mintInput.inputs[3] : undefined;
  const abiFields =
    configArg !== undefined && "components" in configArg
      ? (configArg.components as readonly { name?: string }[]).map((c) => c.name ?? "")
      : [];

  check(
    "CapsuleConfig field order matches CapsuleMinter.sol",
    solidityFields.length === 6 && solidityFields.join(",") === abiFields.join(","),
    `sol [${solidityFields.join(" ")}] vs abi [${abiFields.join(" ")}]`,
  );

  // And that `buildMintParams` fills those same names — a rename in the ABI
  // with no rename here would produce an object viem encodes as empty strings.
  const params = buildMintParams(fakePrepared("check", zeroAddress, zeroAddress));
  check(
    "buildMintParams supplies every struct field",
    abiFields.every((name) => name in params[3]) && Object.keys(params[3]).length === abiFields.length,
    Object.keys(params[3]).join(" "),
  );

  // --- 2. the minter can still write ---------------------------------------
  check("checkResolverRoles() passes", await minterCanWrite(client, minter), "minter holds root roles on the resolver");

  // --- 3. a free label simulates -------------------------------------------
  //
  // Random, so a rerun never collides with the previous run's leftovers — and
  // since this is eth_call, nothing is left over.
  const label = `check${Math.random().toString(36).slice(2, 10)}`;
  const owner = "0x000000000000000000000000000000000000dEaD" as Address;
  const agent = "0x00000000000000000000000000000000DeaDBeef" as Address;

  let simulated: { tokenId: bigint; node: string } | null = null;
  try {
    const { result } = await client.simulateContract({
      address: minter,
      abi: minterAbi,
      functionName: "mint",
      args: buildMintParams(fakePrepared(label, owner, agent)),
      account: owner,
    });
    simulated = { tokenId: result[0], node: result[1] };
    check("a free label mints", true, `token ${result[0]}`);
  } catch (error) {
    check("a free label mints", false, `reverted with ${revertNameOf(error)}`);
  }

  // The node the contract computes has to be the node this app computes, or the
  // fleet reads a different name than the one that was minted.
  if (simulated !== null) {
    const local = encodeName(`${label}.${env.parentName}`).node;
    check("returned node matches encodeName()", simulated.node === local, `${simulated.node} vs ${local}`);
  }

  // --- 4. the reverts the UI names -----------------------------------------
  async function expectRevert(name: string, args: Parameters<typeof buildMintParams>[0], expected: string) {
    try {
      await client.simulateContract({
        address: minter,
        abi: minterAbi,
        functionName: "mint",
        args: buildMintParams(args),
        account: owner,
      });
      check(name, false, "did not revert");
    } catch (error) {
      const got = revertNameOf(error);
      check(name, got === expected, `${got}`);
    }
  }

  await expectRevert(
    "a zero agent reverts with ZeroAddress",
    fakePrepared(`check${Math.random().toString(36).slice(2, 8)}`, owner, zeroAddress),
    "ZeroAddress",
  );
  await expectRevert(
    "a zero owner reverts with ZeroAddress",
    fakePrepared(`check${Math.random().toString(36).slice(2, 8)}`, zeroAddress, agent),
    "ZeroAddress",
  );
  await expectRevert("a 64-byte label reverts with InvalidLabel", fakePrepared("z".repeat(64), owner, agent), "InvalidLabel");
  await expectRevert("an empty label reverts with InvalidLabel", fakePrepared("", owner, agent), "InvalidLabel");

  // A label that is already registered must fail too — this is the race the
  // launchpad's simulation exists to catch. The revert comes from the registry
  // underneath the minter, so it does NOT decode against minterAbi, and the UI
  // says so in words rather than guessing a name.
  const mintedLogs = await client.getLogs({
    address: minter,
    event: minterAbi.find((i) => i.type === "event" && i.name === "CapsuleMinted") as never,
    fromBlock: env.minterBlock,
    toBlock: "latest",
  });
  check("\nthe minter has mints to read", mintedLogs.length > 0, `${mintedLogs.length} CapsuleMinted logs`);

  if (mintedLogs.length > 0) {
    // --- 5. the event decodes, through the shipped function -----------------
    // `getLogs` with an ABI item cast to `never` loses the log type; the three
    // fields `capsuleMintedFrom` reads are restored here rather than everywhere.
    const first = mintedLogs[0]! as unknown as { address: string; topics: `0x${string}`[]; data: `0x${string}` };
    const parsed = capsuleMintedFrom([first] as never, minter);
    check("capsuleMintedFrom decodes a real log", parsed !== null);
    if (parsed !== null) {
      const local = encodeName(`${parsed.label}.${env.parentName}`).node;
      check("  its node matches the label it carries", parsed.node === local, `${parsed.label} → ${parsed.node}`);
      check("  it carries an owner and an agent", parsed.owner !== zeroAddress && parsed.agent !== zeroAddress, `${parsed.owner} / ${parsed.agent}`);
      check("  its tokenId is non-zero", parsed.tokenId > 0n, parsed.tokenId.toString());
    }

    // A log from a different contract must not be read as this mint.
    check(
      "  a log from another address is ignored",
      capsuleMintedFrom([{ ...first, address: "0x000000000000000000000000000000000000bEEF" }] as never, minter) === null,
    );

    // --- 6. the taken-label race -------------------------------------------
    const taken = capsuleMintedFrom([first] as never, minter)!.label;
    try {
      await client.simulateContract({
        address: minter,
        abi: minterAbi,
        functionName: "mint",
        args: buildMintParams(fakePrepared(taken, owner, agent)),
        account: owner,
      });
      check(`re-minting "${taken}" reverts`, false, "it did not");
    } catch (error) {
      const got = revertNameOf(error);
      check(`re-minting "${taken}" reverts`, got !== null, `${got} (undecoded is expected — it is the registry's)`);
    }
  }

  // --- 7. the seam: a real prepare response feeds a real mint ---------------
  //
  // The two halves of the launchpad are written in different files, run in
  // different processes and are checked separately, which is exactly how a
  // field name drifts between them without either check noticing. This is the
  // one assertion that covers the join: sign a genuine prepare request, take
  // the response *verbatim*, and hand it to the chain.
  //
  // It is still gas-free — the mint is simulated, never sent — but it does
  // write to the database, so it cleans up after itself.
  const reachable = await fetch(`${BASE}/api/health`)
    .then((r) => r.ok)
    .catch(() => false);

  if (!reachable) {
    console.log(`\n  skip  prepare→mint seam — nothing answering at ${BASE} (start the app to check it)`);
  } else {
    const seamOwner = privateKeyToAccount(generatePrivateKey());
    const seamLabel = `${SEAM_LABEL}${Math.random().toString(36).slice(2, 8)}`;

    let prepared: PrepareResult | null = null;
    try {
      prepared = await prepareCapsuleRequest(
        {
          label: seamLabel,
          owner: seamOwner.address,
          context: "A check that the prepare response mints.",
          telegramUrl: "https://t.me/capsulecheckbot",
          model: "anthropic/claude-opus-5",
          prompt: "You exist for the length of one eth_call.",
          telegramToken: "123456789:AAHcheckcheckcheckcheckcheckcheck",
          providerKey: "sk-check-not-a-real-key",
        },
        (args) => seamOwner.signMessage({ message: args.message }),
        { baseUrl: BASE, parentName: env.parentName },
      );
      check("\nprepare accepts a request the launch form would send", true, `agent ${prepared.agent}`);
    } catch (error) {
      check("\nprepare accepts a request the launch form would send", false, String(error));
    }

    if (prepared !== null) {
      // The response is the mint's only source of truth. If prepare ever stops
      // filling one of these, the mint writes an empty record and nothing fails.
      check("  it names the label it was asked for", prepared.label === seamLabel, prepared.label);
      check("  it echoes the owner that signed", prepared.owner.toLowerCase() === seamOwner.address.toLowerCase());
      check("  it returns an agent address", /^0x[0-9a-fA-F]{40}$/.test(prepared.agent), prepared.agent);
      check("  the agent is not the owner", prepared.agent.toLowerCase() !== seamOwner.address.toLowerCase());
      check(
        "  promptPointer is the promptRef",
        prepared.config.promptPointer === prepared.promptRef && prepared.promptRef !== "",
        prepared.promptRef,
      );
      check("  capsuleEndpoint is set", prepared.config.capsuleEndpoint !== "", prepared.config.capsuleEndpoint);
      check("  every config field is filled", Object.values(prepared.config).every((v) => v !== ""));

      // Nothing sealed may come back out. This is the response the browser
      // holds in memory and it must not carry the credentials it just stored.
      const asText = JSON.stringify(prepared);
      check(
        "  it echoes no secret",
        !asText.includes("sk-check-not-a-real-key") && !asText.includes("AAHcheckcheckcheckcheckcheckcheck"),
      );

      try {
        const { result } = await client.simulateContract({
          address: minter,
          abi: minterAbi,
          functionName: "mint",
          args: buildMintParams(prepared),
          account: seamOwner.address,
        });
        const local = encodeName(prepared.capsuleName).node;
        check("  the chain accepts it as a mint", true, `token ${result[0]}`);
        check("  the node it would create is the prepared name", result[1] === local, `${result[1]} vs ${local}`);
      } catch (error) {
        check("  the chain accepts it as a mint", false, `reverted with ${revertNameOf(error)}`);
      }
    }

    // ---- cleanup ----------------------------------------------------------
    // One statement per table: this is serverless Postgres over HTTP, and a
    // twenty-query cleanup loop fails runs for reasons unrelated to the code.
    const sql = neon(env.databaseUrl);
    const prefix = `${SEAM_LABEL}%`;
    await sql`delete from capsule_secret where capsule_name like ${prefix}`;
    await sql`delete from capsule_agent  where capsule_name like ${prefix}`;
    await sql`delete from capsule_prompt where capsule_name like ${prefix}`;
    await sql`delete from capsule_prepare_attempt where capsule_name like ${prefix}`;
    const left = (await sql`
      select
        (select count(*) from capsule_agent  where capsule_name like ${prefix}) +
        (select count(*) from capsule_prompt where capsule_name like ${prefix}) +
        (select count(*) from capsule_secret where capsule_name like ${prefix}) +
        (select count(*) from capsule_prepare_attempt where capsule_name like ${prefix}) as n
    `) as { n: string }[];
    check("  cleaned up every row it wrote", Number(left[0]?.n ?? -1) === 0, `${left[0]?.n} left`);
  }

  console.log(`\n${failures === 0 ? "mint path OK" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
