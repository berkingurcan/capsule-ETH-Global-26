/**
 * Proves the fleet read path against the live chain.
 *
 * Three of the things `lib/capsule/fleet.ts` does fail *silently* when they are
 * wrong — an empty array, never an exception — so a build that compiles and a
 * page that renders prove nothing. This script asserts the parts that would
 * otherwise be believed:
 *
 *   1. `textResourceOf` matches `CapsuleMinter.textResourceOf` exactly. Get this
 *      wrong and every capsule reads as recalled, or none ever does.
 *   2. The `TextChanged` filter returns the writes we know are there.
 *   3. The `EACRolesChanged` signature matches the deployed resolver's, so a
 *      recall is visible at all.
 *   4. `authorized` agrees with the minter's own `isAgentAuthorized`.
 *
 * Run with:  npm run check:fleet
 */
import { createPublicClient, http, zeroAddress } from "viem";
import { sepolia } from "viem/chains";
import { ETH_REGISTRY, minterAbi, registryAbi } from "../lib/capsule/chain";
import { RECORD_KEYS } from "../lib/capsule/records";
import { readFleet, textResourceOf } from "../lib/capsule/fleet";
import { loadServerEnv } from "../lib/capsule/env";
import { encodeParent } from "../lib/capsule/parent";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  const env = loadServerEnv();
  const client = createPublicClient({
    chain: sepolia,
    transport: http(env.rpcUrl, { batch: true }),
  });

  // Which parent to check. One minter serves every connected name, so this is
  // scoped to one of them and says so, rather than pretending "the fleet" is
  // still a single thing.
  //
  // Takeable as an argument because defaulting to `CAPSULE_PARENT_NAME` is what
  // made this script useless at the moment it was most needed. Every per-capsule
  // assertion below lives inside a loop over `fleet.capsules`; point the script
  // at a parent that has never been minted under and the loop body never runs,
  // so the checks do not fail — they simply do not happen, and the script reports
  // two vacuous failures while a real fleet was rendering every capsule as
  // recalled. A suite that can only inspect one name is one deployment decision
  // away from inspecting nothing.
  //
  //   npm run check:fleet                 # the deployment's default parent
  //   npm run check:fleet -- berkin.eth   # any parent that has capsules
  const requested = process.argv[2]?.trim().toLowerCase();
  const parent = encodeParent(requested !== undefined && requested !== "" ? requested : env.defaultParentName);
  console.log(`minter ${env.minterAddress} from block ${env.minterBlock}`);
  console.log(`parent ${parent.name} · node ${parent.node}\n`);

  const registry = await client.readContract({
    address: ETH_REGISTRY,
    abi: registryAbi,
    functionName: "getSubregistry",
    args: [parent.label],
  });
  check(`${parent.name} has a subregistry`, registry !== zeroAddress, registry);

  const [connected, registrarGranted, resolverRolesGranted, open] = await client.readContract({
    address: env.minterAddress,
    abi: minterAbi,
    functionName: "readiness",
    args: [registry, env.minterAddress],
  });
  check("  the parent is connected to the minter", connected);
  check("  the minter holds ROLE_REGISTRAR", registrarGranted);
  check("  the minter holds its resolver roles", resolverRolesGranted);
  console.log(`  open to anyone: ${open}\n`);

  const started = Date.now();
  const fleet = await readFleet(client as never, {
    minter: env.minterAddress,
    parentName: parent.name,
    parentNode: parent.node,
    fromBlock: env.minterBlock,
  });
  console.log(`read ${fleet.capsules.length} capsule(s) at block ${fleet.block} in ${Date.now() - started}ms\n`);

  // Said loudly, because everything below is a loop over `fleet.capsules` and an
  // empty fleet skips all of it. A run that reports only this failure has checked
  // nothing about the read path — it has checked that nobody minted here.
  check(
    "fleet is not empty",
    fleet.capsules.length > 0,
    fleet.capsules.length > 0
      ? `${fleet.capsules.length} minted`
      : `0 minted under ${parent.name} — every per-capsule check below was SKIPPED,` +
        ` not passed. Re-run against a parent that has capsules:` +
        ` npm run check:fleet -- <name>`,
  );

  for (const capsule of fleet.capsules) {
    console.log(`\n${capsule.name}`);
    console.log(
      `  status=${capsule.status} authorized=${capsule.authorized} beats=${capsule.beatCount}` +
        ` cadence=${capsule.cadence ?? "?"}s quiet=${capsule.quietFor ?? "never"}s`,
    );
    console.log(`  model=${capsule.records.model} prompt=${capsule.records.prompt} heartbeat="${capsule.records.heartbeat}"`);

    // 1. The resource id must agree with the contract, or every role check is
    //    asking about a resource that does not exist — which reads as `false`.
    const onChain = await client.readContract({
      address: env.minterAddress,
      abi: minterAbi,
      functionName: "textResourceOf",
      args: [capsule.node, RECORD_KEYS.heartbeat],
    });
    check("  textResourceOf matches the contract", textResourceOf(capsule.node, RECORD_KEYS.heartbeat) === onChain);

    // 4. And the derived flag must agree with the minter's own view.
    const authorized = await client.readContract({
      address: env.minterAddress,
      abi: minterAbi,
      functionName: "isAgentAuthorized",
      args: [registry, capsule.label, capsule.agent],
    });
    check("  authorized agrees with isAgentAuthorized", capsule.authorized === authorized);

    // 2. The mint itself wrote every record key, so a name that resolves must
    //    have at least that many writes in its history.
    check("  record writes were found", capsule.writes.length > 0, `${capsule.writes.length} writes`);

    // The live record and the last write of that key must agree. If they do not,
    // the event filter is reading a different name than the resolver is.
    const lastPromptWrite = capsule.writes.find((w) => w.key === RECORD_KEYS.prompt);
    check(
      "  last agent-prompt write matches the live record",
      lastPromptWrite === undefined || lastPromptWrite.value === capsule.records.prompt,
      `${lastPromptWrite?.value ?? "none"} vs ${capsule.records.prompt}`,
    );

    const lastBeatWrite = capsule.lastBeat;
    check(
      "  last heartbeat write matches the live record",
      (lastBeatWrite?.value ?? "") === capsule.records.heartbeat,
      `${lastBeatWrite?.value ?? "none"} vs "${capsule.records.heartbeat}"`,
    );

    check("  registration record is present", capsule.registrationValue !== "", capsule.registrationKey);
    check("  class is Agent", capsule.records.class === "Agent");
  }

  // 3. A recall is only visible if the EACRolesChanged signature is right. The
  //    fleet has a known revoke/regrant pair in its history (the Phase 5 gate), so
  //    an empty role feed here means the ABI is wrong, not that nothing happened.
  const roleEvents = fleet.events.filter((e) => e.kind === "recalled" || e.kind === "granted");
  check(
    "\nEACRolesChanged decodes (role events found)",
    roleEvents.length > 0,
    `${roleEvents.length} grant/revoke events`,
  );

  check("activity feed is ordered newest first", fleet.events.every((e, i, all) => i === 0 || all[i - 1].block >= e.block));
  check("every event has a name", fleet.events.every((e) => e.name !== "unknown"));

  console.log(`\n${failures === 0 ? "fleet read path OK" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
