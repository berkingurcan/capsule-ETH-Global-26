/**
 * Drift guard for everything the web side copies from the runner.
 *
 * Two contracts, both copied for the same reason: the runner ships as an independent
 * container and cannot take a workspace dependency.
 *
 *   lib/capsule/wire.ts     restates runner/src/prompt.ts and runner/src/runtime.ts —
 *                           the signed-request shapes.
 *   lib/capsule/records.ts  restates runner/src/records.ts — the ENS record keys.
 *
 * The second matters more than it looks. The resolver derives a per-key permission from
 * the key string but reverts against the name-level resource whichever key was denied, so
 * a key that drifts by one character produces a revert byte-identical to a revocation.
 * A dashboard would show empty records; a runner would halt claiming it was recalled.
 *
 * This script reads the runner sources as text and asserts the parts that must agree
 * still agree.
 *
 * Text, not import, on purpose: the runner is a separate npm project with its
 * own resolution, and a guard that needs a build step is a guard people skip.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  PROMPT_FETCH_PREFIX,
  RUNTIME_FETCH_PREFIX,
  SIGNATURE_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
  HEADER_NAME,
  HEADER_TIMESTAMP,
  HEADER_SIGNATURE,
  promptFetchMessage,
  runtimeFetchMessage,
} from "../lib/capsule/wire";
import * as records from "../lib/capsule/records";

const here = dirname(fileURLToPath(import.meta.url));
const runnerSrc = (file: string) => resolve(here, `../../runner/src/${file}`);

const source = readFileSync(runnerSrc("prompt.ts"), "utf8");
const runtimeSource = readFileSync(runnerSrc("runtime.ts"), "utf8");
const recordsSource = readFileSync(runnerSrc("records.ts"), "utf8");

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

const expect = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail });
};

const find = (label: string, re: RegExp): string | undefined => {
  const m = re.exec(source);
  if (m === null) {
    expect(label, false, `could not find ${label} in runner/src/prompt.ts`);
    return undefined;
  }
  return m[1];
};

// 1. The domain separator.
const prefix = find("prefix", /PROMPT_FETCH_PREFIX\s*=\s*"([^"]+)"/);
if (prefix !== undefined) {
  expect("prefix", prefix === PROMPT_FETCH_PREFIX, `runner "${prefix}" vs web "${PROMPT_FETCH_PREFIX}"`);
}

// 2. The replay window.
const ttl = find("ttl", /SIGNATURE_TTL_SECONDS\s*=\s*(\d+)/);
if (ttl !== undefined) {
  expect("ttl", Number(ttl) === SIGNATURE_TTL_SECONDS, `runner ${ttl}s vs web ${SIGNATURE_TTL_SECONDS}s`);
}

// 3. Clock skew slack, which the runner inlines in isTimestampFresh.
const skew = find("skew", /age\s*>=\s*-(\d+)/);
if (skew !== undefined) {
  expect("skew", Number(skew) === CLOCK_SKEW_SECONDS, `runner ${skew}s vs web ${CLOCK_SKEW_SECONDS}s`);
}

// 4. The message body: same fields, same order, same separator. Reproduce the
//    runner's join expression rather than trusting that it still reads the way
//    it did when this was written.
const joinMatch = /return \[(PROMPT_FETCH_PREFIX, name, promptRef, String\(timestamp\))\]\.join\("\\n"\)/.exec(source);
expect(
  "message shape",
  joinMatch !== null,
  joinMatch !== null
    ? "prefix\\nname\\nref\\ntimestamp"
    : "runner's promptFetchMessage no longer joins [prefix, name, ref, timestamp] with \\n",
);

// 5. Header names, read off the runner's fetch call.
for (const [label, header] of [
  ["header name", HEADER_NAME],
  ["header timestamp", HEADER_TIMESTAMP],
  ["header signature", HEADER_SIGNATURE],
] as const) {
  expect(label, source.includes(`"${header}":`), `runner does not send ${header}`);
}

// 6. A worked example, so a refactor that keeps the literals but changes the
//    assembly still trips.
const sample = promptFetchMessage("analyst.capsulefleet.eth", "cap_8f3d1a", 1757260800);
expect(
  "sample",
  sample === "capsule-prompt-fetch\nanalyst.capsulefleet.eth\ncap_8f3d1a\n1757260800",
  JSON.stringify(sample),
);

// --- the runtime credential fetch ----------------------------------------
//
// A separate domain separator is the whole security property here: the same key signs
// both requests inside the same window, so if these two prefixes ever became equal, a
// signature captured from a prompt fetch would open the endpoint that hands out the
// owner's Telegram bot token.
const runtimePrefixMatch = /RUNTIME_FETCH_PREFIX\s*=\s*"([^"]+)"/.exec(runtimeSource);
if (runtimePrefixMatch === null) {
  expect("runtime prefix", false, "could not find RUNTIME_FETCH_PREFIX in runner/src/runtime.ts");
} else {
  expect(
    "runtime prefix",
    runtimePrefixMatch[1] === RUNTIME_FETCH_PREFIX,
    `runner "${runtimePrefixMatch[1]}" vs web "${RUNTIME_FETCH_PREFIX}"`,
  );
}

expect(
  "runtime prefix differs from prompt",
  // Compared as plain strings: both are `const`, so TypeScript narrows them to distinct
  // literal types and would reject the comparison as provably false — which is the state
  // we want, but only a compile-time one. This check has to survive someone editing them.
  (RUNTIME_FETCH_PREFIX as string) !== (PROMPT_FETCH_PREFIX as string),
  "the credential endpoint must not accept a signature made for a prompt fetch",
);

expect(
  "runtime message shape",
  /return \[RUNTIME_FETCH_PREFIX, name, String\(timestamp\)\]\.join\("\\n"\)/.test(runtimeSource),
  "runner's runtimeFetchMessage no longer joins [prefix, name, timestamp] with \\n",
);

expect(
  "runtime sample",
  runtimeFetchMessage("analyst.capsulefleet.eth", 1757260800) ===
    "capsule-runtime-fetch\nanalyst.capsulefleet.eth\n1757260800",
  JSON.stringify(runtimeFetchMessage("analyst.capsulefleet.eth", 1757260800)),
);

// --- the record keys ------------------------------------------------------
//
// Every key the web side names is re-derived from the runner's records.ts. A key present
// on one side and absent from the other is the failure this catches.
const runnerKeys = new Map<string, string>();
for (const [, name, value] of recordsSource.matchAll(
  /export const (KEY_[A-Z_]+|CLASS_AGENT|RUNTIME_OPENCLAW)\s*=\s*"([^"]*)"/g,
)) {
  runnerKeys.set(name, value);
}
// KEY_ENDPOINT_* are built through endpointKey(), so they are derived rather than literal.
const endpointFn = /return `agent-endpoint\[\$\{protocol\}\]`/.test(recordsSource);
expect("endpointKey shape", endpointFn, "runner's endpointKey no longer renders agent-endpoint[<protocol>]");
for (const [name, protocol] of [
  ["KEY_ENDPOINT_CAPSULE", "capsule"],
  ["KEY_ENDPOINT_WEB", "web"],
] as const) {
  const declared = new RegExp(`export const ${name} = endpointKey\\("${protocol}"\\)`).test(recordsSource);
  if (declared && endpointFn) runnerKeys.set(name, `agent-endpoint[${protocol}]`);
}

expect(
  "record key count",
  runnerKeys.size >= 11,
  `only found ${runnerKeys.size} keys in runner/src/records.ts — the parser or the file moved`,
);

for (const [name, runnerValue] of runnerKeys) {
  const webValue = (records as unknown as Record<string, unknown>)[name];
  expect(
    `key ${name}`,
    webValue === runnerValue,
    `runner "${runnerValue}" vs web ${JSON.stringify(webValue)}`,
  );
}

// ENSIP-27 requires kebab-case, and a dot creeping back in is exactly the regression this
// whole rename was. Checked against the web copy, which is what the UI and routes use.
for (const [name, value] of Object.entries(records)) {
  if (!name.startsWith("KEY_") || typeof value !== "string") continue;
  expect(
    `kebab ${name}`,
    /^[a-z]+(-[a-z]+)*(\[[a-z]+\])?$/.test(value),
    `"${value}" is not a kebab-case ENSIP-27 attribute key`,
  );
}

let failed = 0;
for (const c of checks) {
  if (c.ok) {
    console.log(`  ok    ${c.name}`);
  } else {
    failed += 1;
    console.log(`  DRIFT ${c.name} — ${c.detail}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) drifted. lib/capsule/{wire,records}.ts must agree with runner/src/.`);
  process.exit(1);
}
console.log(`\nwire and record contracts match runner/src/ (${checks.length} checks)`);
