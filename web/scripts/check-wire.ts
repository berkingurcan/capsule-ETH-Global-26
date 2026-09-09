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
  PREPARE_PREFIX,
  prepareMessage,
  PROMPT_FETCH_PREFIX,
  RUNTIME_FETCH_PREFIX,
  runtimeFetchMessage,
  SIGNATURE_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
  HEADER_NAME,
  HEADER_TIMESTAMP,
  HEADER_SIGNATURE,
  promptFetchMessage,
} from "../lib/capsule/wire";

const here = dirname(fileURLToPath(import.meta.url));
const runnerPrompt = resolve(here, "../../runner/src/prompt.ts");
const runnerRuntime = resolve(here, "../../runner/src/runtime.ts");

const source = readFileSync(runnerPrompt, "utf8");
const runtimeSource = readFileSync(runnerRuntime, "utf8");

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

// 7. The runtime path: same discipline, a different separator.
//
// Checked here rather than in a second script because the failure mode is the
// same one — a 403 that the runner cannot distinguish from a revoked permission
// — and because the two prefixes being *different* is itself the property worth
// asserting.
const runtimePrefix = /RUNTIME_FETCH_PREFIX\s*=\s*"([^"]+)"/.exec(runtimeSource)?.[1];
expect(
  "runtime prefix",
  runtimePrefix === RUNTIME_FETCH_PREFIX,
  `runner "${runtimePrefix ?? "<missing>"}" vs web "${RUNTIME_FETCH_PREFIX}"`,
);

// Compared as the runner actually spells them, not as the web constants: the
// web literals have distinct types, so TypeScript proves that comparison at
// compile time and the assertion tells us nothing about the runner.
expect(
  "runtime prefix is distinct",
  runtimePrefix !== undefined && prefix !== undefined && runtimePrefix !== prefix,
  "a signature for the prompt path would open the credential path",
);

// The runtime path reuses the prompt path's TTL rather than restating it. If a
// future edit gives it its own literal, this stops being true and the two
// windows can drift apart unnoticed.
expect(
  "runtime reuses the prompt TTL",
  /export \{ SIGNATURE_TTL_SECONDS \}/.test(runtimeSource),
  "runner/src/runtime.ts no longer re-exports the prompt TTL — it may have grown its own",
);

const runtimeJoin =
  /return \[(RUNTIME_FETCH_PREFIX, name, String\(timestamp\))\]\.join\("\\n"\)/.test(runtimeSource);
expect("runtime message shape", runtimeJoin, "runner assembles the runtime message differently");

const runtimeSample = runtimeFetchMessage("analyst.capsulefleet.eth", 1757260800);
expect(
  "runtime sample",
  runtimeSample === "capsule-runtime-fetch\nanalyst.capsulefleet.eth\n1757260800",
  JSON.stringify(runtimeSample),
);

let failed = 0;
////////////////////////////////////////////////////////////////////////////
// The launchpad's separator
////////////////////////////////////////////////////////////////////////////

// `capsule-prepare` has no runner counterpart — it is signed in a browser by a
// person, not by an agent — so there is nothing to compare it against. What
// still has to hold is that it is distinct from both agent separators, because
// it authorises a *write* and the other two authorise reads. A signature
// captured from any one of the three must be useless on the other two.
//
// Compared against the prefixes as the RUNNER spells them, not against the web
// constants: those are distinct string literal types, so TypeScript already
// proves they differ and asserting it at runtime would tell us nothing. What is
// worth asserting is that the browser's separator does not collide with what
// the agent side actually sends — the same reasoning the runtime check above
// uses.
const agentPrefixes = [prefix, runtimePrefix].filter((p): p is string => p !== undefined);
expect(
  "prepare prefix is distinct from both agent prefixes",
  agentPrefixes.length === 2 && !agentPrefixes.includes(PREPARE_PREFIX),
  `prepare "${PREPARE_PREFIX}" vs runner [${agentPrefixes.join(", ")}]`,
);

// The prepare message carries a body digest; the other two carry no content at
// all. This asserts the digest is actually in the signed string — dropping it
// would leave a signature that says "this address wanted to prepare something"
// rather than "this address wanted to prepare this".
const prepareSample = prepareMessage(
  "analyst.capsulefleet.eth",
  "0x9E0283E37Bd2F2c6bEFC29b89CF2d86fe5b5fB71",
  "0xdeadbeef",
  1757260800,
);
expect(
  "prepare sample",
  prepareSample ===
    "capsule-prepare\nanalyst.capsulefleet.eth\n0x9e0283e37bd2f2c6befc29b89cf2d86fe5b5fb71\n0xdeadbeef\n1757260800",
  JSON.stringify(prepareSample),
);

expect(
  "prepare message binds the body digest",
  prepareSample.includes("0xdeadbeef"),
  "the signature would not cover the request body",
);

for (const c of checks) {
  if (c.ok) {
    console.log(`  ok    ${c.name}`);
  } else {
    failed += 1;
    console.log(`  DRIFT ${c.name} — ${c.detail}`);
  }
}

if (failed > 0) {
  console.error(
    `\n${failed} check(s) drifted. lib/capsule/wire.ts must agree with` +
      ` runner/src/prompt.ts and runner/src/runtime.ts.`,
  );
  process.exit(1);
}
console.log(`\nwire contract matches runner/src/prompt.ts and runner/src/runtime.ts (${checks.length} checks)`);
