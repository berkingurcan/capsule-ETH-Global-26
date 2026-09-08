/**
 * Drift guard for the record keys.
 *
 * Three copies of the same strings exist and they cannot import each other:
 * Solidity is a different language, and the runner ships as an independent
 * container with its own npm resolution. So they are duplicated, and this
 * asserts they still agree.
 *
 * Why it earns its keep: a mismatch between the key that was authorized and the
 * key that gets written does not fail loudly. `PermissionedResolver` reverts
 * against the *name-level* resource whichever key was denied, so a stale string
 * produces the same bytes as a revocation — the runner halts, the dashboard goes
 * red, and everything looks like the kill switch working correctly.
 *
 * Text, not import, for the two files it cannot own: the same reasoning as
 * check-wire.ts. A guard that needs a build step is a guard people skip.
 *
 *   npm run check:records
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  CLASS_VALUE,
  OWN_SCHEMA_KEYS,
  RECORD_KEYS,
  REGISTRATION_VALUE,
  registrationKey,
  type RecordKeyName,
} from "../lib/capsule/records";

const here = dirname(fileURLToPath(import.meta.url));
const webCopy = resolve(here, "../lib/capsule/records.ts");
const runnerCopy = resolve(here, "../../runner/src/records.ts");
const minterSource = resolve(here, "../../contracts/src/CapsuleMinter.sol");

type Check = { name: string; ok: boolean; detail: string; pending?: boolean };
const checks: Check[] = [];
const expect = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

/**
 * Keys exempted from the ENSIP-27 attribute check while they still carry a
 * pre-ENSIP spelling on a live deployment.
 *
 * Empty since Phase 2: the kebab-case rename shipped with a new minter, and
 * names on the old one are not migrated. Kept, not deleted, because the same
 * situation recurs on the next spec change — and because the list is
 * self-cleaning: a key in here that already conforms is reported as drift, so
 * an exemption cannot outlive the rename it was covering.
 */
const PENDING_RENAME = new Set<string>([]);

/** Like expect, but a known-pending key is reported rather than failing the run. */
const expectConformance = (name: string, key: string, ok: boolean, detail: string) => {
  const pending = PENDING_RENAME.has(key);
  if (pending && !ok) {
    checks.push({ name, ok: true, detail: "", pending: true });
    return;
  }
  if (pending && ok) {
    checks.push({ name, ok: false, detail: `"${key}" now conforms — remove it from PENDING_RENAME` });
    return;
  }
  checks.push({ name, ok, detail });
};

// ---------------------------------------------------------------------------
// 1. The two TypeScript copies are byte-identical.
//
// Stronger than comparing parsed values, and it catches a divergent comment —
// which matters, because the comments are where the Phase 2 rename plan lives.
// ---------------------------------------------------------------------------
const webText = readFileSync(webCopy, "utf8");
const runnerText = readFileSync(runnerCopy, "utf8");

if (webText === runnerText) {
  expect("copies identical", true, "");
} else {
  const w = webText.split("\n");
  const r = runnerText.split("\n");
  let line = 0;
  while (line < Math.max(w.length, r.length) && w[line] === r[line]) line += 1;
  expect(
    "copies identical",
    false,
    `first difference at line ${line + 1}\n    web:    ${w[line] ?? "<eof>"}\n    runner: ${r[line] ?? "<eof>"}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Every key agrees with the Solidity constant that writes or authorizes it.
// ---------------------------------------------------------------------------
const solidity = readFileSync(minterSource, "utf8");

/** Solidity constant name -> the property in RECORD_KEYS it must equal. */
const SOLIDITY_KEYS: Record<string, RecordKeyName> = {
  KEY_CLASS: "class",
  KEY_SCHEMA: "schema",
  KEY_CONTEXT: "context",
  KEY_ENDPOINT_WEB: "endpointWeb",
  KEY_ENDPOINT_CAPSULE: "endpointCapsule",
  KEY_MODEL: "model",
  KEY_RUNTIME: "runtime",
  KEY_PROMPT: "prompt",
  KEY_HEARTBEAT: "heartbeat",
};

for (const [constant, property] of Object.entries(SOLIDITY_KEYS)) {
  const match = new RegExp(`string public constant ${constant} = "([^"]*)";`).exec(solidity);
  if (match === null) {
    expect(constant, false, `not found in CapsuleMinter.sol — did it get renamed?`);
    continue;
  }
  const onChain = match[1];
  const inTs = RECORD_KEYS[property];
  expect(constant, onChain === inTs, `solidity "${onChain}" vs ts RECORD_KEYS.${property} "${inTs}"`);
}

// Every TS key must have a Solidity counterpart. A key the minter never writes
// is a key no name will ever carry.
const covered = new Set(Object.values(SOLIDITY_KEYS));
for (const property of Object.keys(RECORD_KEYS) as RecordKeyName[]) {
  expect(
    `${property} is minted`,
    covered.has(property),
    `RECORD_KEYS.${property} has no KEY_* constant in CapsuleMinter.sol`,
  );
}

// ---------------------------------------------------------------------------
// 3. ENSIP-27: `class` must equal the schema's `title`, and our schema must
//    declare only the keys no ENSIP owns.
// ---------------------------------------------------------------------------
const solidityClass = /string public constant CLASS_VALUE = "([^"]*)";/.exec(solidity);
expect(
  "class value",
  solidityClass !== null && solidityClass[1] === CLASS_VALUE,
  `solidity "${solidityClass?.[1] ?? "<missing>"}" vs ts "${CLASS_VALUE}"`,
);

// ENSIP-27's attribute grammar allows one bracket group. ENSIP-25's
// agent-registration[<registry>][<agentId>] has two, and ENSIP-25 owns it — so it
// must never appear in our schema. Same for anything ENSIP-5/26/27 already defines.
const ENSIP_OWNED: string[] = [
  RECORD_KEYS.class,
  RECORD_KEYS.schema,
  RECORD_KEYS.context,
  RECORD_KEYS.endpointWeb,
  RECORD_KEYS.endpointCapsule,
];
const leaked = OWN_SCHEMA_KEYS.filter((k) => (ENSIP_OWNED as string[]).includes(k));
expect("schema declares only our keys", leaked.length === 0, `an ENSIP already owns: ${leaked.join(", ")}`);

const ENSIP27_ATTRIBUTE = /^[a-z0-9]+(-[a-z0-9]+)*(\[[^\]]+\])?$/;
for (const key of OWN_SCHEMA_KEYS) {
  expectConformance(
    `${key} is a valid ENSIP-27 attribute`,
    key,
    ENSIP27_ATTRIBUTE.test(key),
    `"${key}" must be kebab-case with at most one bracket group`,
  );
}

// ---------------------------------------------------------------------------
// 4. ENSIP-25: the registration key is built the same way in both languages.
//
// It is the one key neither side stores as a constant — Solidity concatenates it
// from the ERC-7930 registry address, TypeScript from a template literal. If the
// two prefixes ever diverge, a client verifying the name reads an empty record
// and concludes the agent is unregistered.
// ---------------------------------------------------------------------------
const solidityRegistrationPrefix = /"(agent-registration\[)"/.exec(solidity);
const tsRegistrationPrefix = registrationKey("<r>", "<a>").slice(0, "agent-registration[".length);
expect(
  "registration key prefix",
  solidityRegistrationPrefix !== null && solidityRegistrationPrefix[1] === tsRegistrationPrefix,
  `solidity "${solidityRegistrationPrefix?.[1] ?? "<missing>"}" vs ts "${tsRegistrationPrefix}"`,
);

expect(
  "registration key shape",
  registrationKey("0xdead", 7n) === "agent-registration[0xdead][7]",
  `got "${registrationKey("0xdead", 7n)}"`,
);

const solidityRegistrationValue = /string internal constant REGISTRATION_VALUE = "([^"]*)";/.exec(solidity);
expect(
  "registration value",
  solidityRegistrationValue !== null && solidityRegistrationValue[1] === REGISTRATION_VALUE,
  `solidity "${solidityRegistrationValue?.[1] ?? "<missing>"}" vs ts "${REGISTRATION_VALUE}" (ENSIP-25 requires non-empty)`,
);

// ---------------------------------------------------------------------------

let failed = 0;
for (const c of checks) {
  if (c.pending === true) {
    console.log(`  pend  ${c.name} — exempt, see PENDING_RENAME`);
  } else if (c.ok) {
    console.log(`  ok    ${c.name}`);
  } else {
    failed += 1;
    console.log(`  DRIFT ${c.name} — ${c.detail}`);
  }
}

if (failed > 0) {
  console.error(
    `\n${failed} check(s) drifted. CapsuleMinter.sol, runner/src/records.ts and` +
      ` lib/capsule/records.ts must agree — see ../Branding-ENSClaw/RECORDS.md.`,
  );
  process.exit(1);
}
const pending = checks.filter((c) => c.pending === true).length;
console.log(`\nrecord keys agree across Solidity, runner and web (${checks.length} checks)`);
if (pending > 0) {
  console.log(`${pending} key(s) exempt from the ENSIP-27 attribute check — see PENDING_RENAME.`);
}
