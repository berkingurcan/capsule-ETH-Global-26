/**
 * Drift guard for the copied prompt-fetch contract.
 *
 * lib/capsule/wire.ts restates what runner/src/prompt.ts defines, because the
 * runner ships as an independent container and cannot take a workspace
 * dependency. This script reads the runner source as text and asserts the
 * parts that must agree still agree.
 *
 * Text, not import, on purpose: the runner is a separate npm project with its
 * own resolution, and a guard that needs a build step is a guard people skip.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  PROMPT_FETCH_PREFIX,
  SIGNATURE_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
  HEADER_NAME,
  HEADER_TIMESTAMP,
  HEADER_SIGNATURE,
  promptFetchMessage,
} from "../lib/capsule/wire";

const here = dirname(fileURLToPath(import.meta.url));
const runnerPrompt = resolve(here, "../../runner/src/prompt.ts");

const source = readFileSync(runnerPrompt, "utf8");

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
  console.error(`\n${failed} check(s) drifted. lib/capsule/wire.ts and runner/src/prompt.ts must agree.`);
  process.exit(1);
}
console.log(`\nwire contract matches runner/src/prompt.ts (${checks.length} checks)`);
