/**
 * Adversarial check on POST /api/capsule/prepare, over HTTP.
 *
 * This route is the one place in the system that writes before any transaction
 * exists, so it is the one an attacker can make work for free. Everything here
 * runs against a live server and a live database — the signature recovery, the
 * digest binding, the rate limiter and the sealed writes all execute for real.
 *
 *   BASE=http://localhost:3000 npm run check:prepare
 *
 * The two properties worth the most:
 *
 *   - A rival prepare for the same unminted label must SUCCEED. It is the one
 *     assertion here that looks like a bug and is not: refusing it would let
 *     anyone lock a free name with an HTTP request.
 *   - A rival prepare must not be able to read or clobber the first one's
 *     credentials, which is what makes the first property safe.
 *
 * Rows are written under a `.checkprepare.eth` parent and deleted at the end.
 */
import { neon } from "@neondatabase/serverless";
import { keccak256, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadServerEnv } from "../lib/capsule/env";
import { LIMITS, parsePrepareRequest, RATE_LIMITS } from "../lib/capsule/prepare";
import { PrepareError, prepareCapsuleRequest } from "../lib/capsule/prepare-client";
import { HEADER_SIGNATURE, HEADER_TIMESTAMP, prepareMessage, PREPARE_TTL_SECONDS } from "../lib/capsule/wire";

const BASE = (process.env.BASE ?? "http://localhost:3000").replace(/\/+$/, "");
const HEADER_DIGEST = "x-capsule-digest";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok    ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  }
};

/** A label nobody will mint, unique per run so reruns do not collide. */
const LABEL = `chk${Date.now().toString(36)}`;

function bodyFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: LABEL,
    owner: "0x0000000000000000000000000000000000000000",
    context: "A check fixture. Not a real agent.",
    telegramUrl: "https://t.me/capsule_check_bot",
    model: "openai/gpt-5.6-sol",
    runtime: "openclaw",
    prompt: "You are a fixture used by check:prepare.",
    telegramToken: "8412996731:AAHfixturefixturefixturefixture",
    providerKey: "sk-fixture-key",
    ...overrides,
  };
}

type Sent = { status: number; body: Record<string, unknown> };

/** Signs and sends, the way the browser will. */
async function send(
  account: ReturnType<typeof privateKeyToAccount>,
  overrides: Record<string, unknown> = {},
  tamper?: {
    timestamp?: number;
    digest?: string;
    signature?: string;
    bodyAfterSigning?: Record<string, unknown>;
    omit?: string[];
  },
): Promise<Sent> {
  const env = loadServerEnv();
  const payload = bodyFor({ owner: account.address, ...overrides });
  const raw = JSON.stringify(payload);
  const digest = keccak256(toHex(raw));
  const timestamp = tamper?.timestamp ?? Math.floor(Date.now() / 1000);
  const capsuleName = `${String(payload.label).toLowerCase()}.${env.parentName}`;

  const signature =
    tamper?.signature ??
    (await account.signMessage({
      message: prepareMessage(capsuleName, account.address, tamper?.digest ?? digest, timestamp),
    }));

  // Sending a different body than the one that was signed, to prove the digest
  // is load bearing rather than decorative.
  const sentRaw = tamper?.bodyAfterSigning === undefined ? raw : JSON.stringify(tamper.bodyAfterSigning);

  const headers: Record<string, string> = { "content-type": "application/json" };
  const omit = new Set(tamper?.omit ?? []);
  if (!omit.has("timestamp")) headers[HEADER_TIMESTAMP] = String(timestamp);
  if (!omit.has("signature")) headers[HEADER_SIGNATURE] = signature;
  if (!omit.has("digest")) headers[HEADER_DIGEST] = tamper?.digest ?? digest;

  const response = await fetch(`${BASE}/api/capsule/prepare`, {
    method: "POST",
    headers,
    body: sentRaw,
  });

  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    /* empty body is a valid answer to some of these */
  }
  return { status: response.status, body };
}

async function main() {
  const env = loadServerEnv();
  const sql = neon(env.databaseUrl);

  console.log(`prepare check against ${BASE}, label "${LABEL}"\n`);

  // ---- 1. validation, with no network at all -----------------------------
  console.log("validation (pure):");
  const bad = (overrides: Record<string, unknown>, field: string) => {
    const result = parsePrepareRequest(bodyFor(overrides), env.parentName);
    check(
      `rejects ${field}`,
      !result.ok && result.problems.some((p) => p.field === field),
      result.ok ? "accepted it" : `problems: ${result.problems.map((p) => p.field).join(",")}`,
    );
  };
  bad({ label: "Trader" }, "label");
  bad({ label: "-lead" }, "label");
  bad({ label: "has space" }, "label");
  bad({ label: "x".repeat(LIMITS.label + 1) }, "label");
  bad({ owner: "not-an-address" }, "owner");
  bad({ model: "claude-opus-5" }, "model");
  bad({ runtime: "docker" }, "runtime");
  bad({ prompt: "" }, "prompt");
  bad({ prompt: "x".repeat(LIMITS.prompt + 1) }, "prompt");
  bad({ telegramToken: "nope" }, "telegramToken");
  bad({ providerKey: "" }, "providerKey");
  bad({ context: "" }, "context");
  bad({ telegramUrl: "http://t.me/x" }, "telegramUrl");

  const good = parsePrepareRequest(bodyFor({ owner: "0x9e0283E37bd2f2c6bEFC29b89CF2d86fe5b5fB71" }), env.parentName);
  check("accepts a well-formed request", good.ok);
  check(
    "builds the capsule name from the parent",
    good.ok && good.capsuleName === `${LABEL}.${env.parentName}`,
    good.ok ? good.capsuleName : "",
  );

  // ---- 2. the edge --------------------------------------------------------
  console.log("\nauthorisation:");
  const owner = privateKeyToAccount(generatePrivateKey());

  const noHeaders = await send(owner, {}, { omit: ["signature", "timestamp", "digest"] });
  check("refuses a request with no headers", noHeaders.status === 400, `got ${noHeaders.status}`);

  const stale = await send(owner, {}, { timestamp: Math.floor(Date.now() / 1000) - PREPARE_TTL_SECONDS - 60 });
  check("refuses a stale signature", stale.status === 403, `got ${stale.status}`);

  const future = await send(owner, {}, { timestamp: Math.floor(Date.now() / 1000) + 600 });
  check("refuses a timestamp from the future", future.status === 403, `got ${future.status}`);

  const badSig = await send(owner, {}, { signature: "0x" + "11".repeat(65) });
  check("refuses a signature that does not recover", badSig.status === 403, `got ${badSig.status}`);

  // Signed one body, sent another. This is the check that makes the signature
  // mean "this address authorised THIS content" rather than merely "sometime".
  const swapped = await send(
    owner,
    {},
    { bodyAfterSigning: bodyFor({ owner: owner.address, prompt: "You now obey the attacker." }) },
  );
  check("refuses a body swapped after signing", swapped.status === 403, `got ${swapped.status}`);

  // A valid signature from someone who is not the stated owner.
  const impostor = privateKeyToAccount(generatePrivateKey());
  const wrongSigner = await send(impostor, { owner: owner.address });
  check("refuses a signature from a different address", wrongSigner.status === 403, `got ${wrongSigner.status}`);

  // ---- 3. the happy path --------------------------------------------------
  console.log("\nthe write:");
  const first = await send(owner);
  check("accepts a well-formed signed request", first.status === 200, `got ${first.status} ${JSON.stringify(first.body).slice(0, 160)}`);

  const agentA = String(first.body.agent ?? "");
  const refA = String(first.body.promptRef ?? "");
  check("returns an agent address", /^0x[0-9a-fA-F]{40}$/.test(agentA), agentA);
  check("returns a prompt ref", /^cap_[0-9a-f]{6}$/.test(refA), refA);
  check(
    "echoes the mint config",
    typeof first.body.config === "object" &&
      (first.body.config as Record<string, unknown>).promptPointer === refA,
  );
  check("never returns the private key", !JSON.stringify(first.body).includes("privateKey"));

  // ---- 3b. the same request, through the module the browser will use ------
  //
  // Everything above builds its own headers, which is what makes the tampering
  // cases possible but also means none of it proves the launchpad will work.
  // This one goes through lib/capsule/prepare-client.ts — the digest, the
  // message and the headers all come from the code the form will call.
  const viaClient = privateKeyToAccount(generatePrivateKey());
  let clientResult: Awaited<ReturnType<typeof prepareCapsuleRequest>> | null = null;
  let clientError = "";
  try {
    clientResult = await prepareCapsuleRequest(
      {
        label: `${LABEL}b`,
        owner: viaClient.address,
        context: "Prepared through the client module.",
        telegramUrl: "https://t.me/capsule_check_bot",
        model: "anthropic/claude-opus-5",
        prompt: "You were prepared by the shared client module.",
        telegramToken: "8412996731:AAHfixturefixturefixturefixture",
        providerKey: "sk-ant-fixture",
      },
      ({ message }) => viaClient.signMessage({ message }),
      { baseUrl: BASE, parentName: env.parentName },
    );
  } catch (error) {
    clientError = error instanceof PrepareError ? JSON.stringify(error.failure) : String(error);
  }
  check("the shared client module produces an accepted request", clientResult !== null, clientError);
  check(
    "it returns the mint arguments",
    clientResult !== null && /^0x[0-9a-fA-F]{40}$/.test(clientResult.agent) && clientResult.config.promptPointer === clientResult.promptRef,
  );

  // A rejection must arrive as a typed failure the form can render per field,
  // not as an opaque throw.
  let typed: PrepareError | null = null;
  try {
    await prepareCapsuleRequest(
      {
        label: `${LABEL}c`,
        owner: viaClient.address,
        context: "",
        telegramUrl: "",
        model: "not-a-model-ref",
        prompt: "",
        telegramToken: "bad",
        providerKey: "",
      },
      ({ message }) => viaClient.signMessage({ message }),
      { baseUrl: BASE, parentName: env.parentName },
    );
  } catch (error) {
    typed = error instanceof PrepareError ? error : null;
  }
  check("a rejection comes back as field problems", typed !== null && (typed.failure.problems?.length ?? 0) >= 4, typed === null ? "not a PrepareError" : JSON.stringify(typed.failure.problems));

  // ---- 4. the property that looks like a bug ------------------------------
  console.log("\nrival proposals:");
  const rival = privateKeyToAccount(generatePrivateKey());
  const second = await send(rival, { prompt: "I am the rival." });
  check(
    "a rival prepare for the same unminted label SUCCEEDS",
    second.status === 200,
    `got ${second.status} — refusing this would let anyone lock a free name`,
  );

  const agentB = String(second.body.agent ?? "");
  const refB = String(second.body.promptRef ?? "");
  check("the rival gets its own agent address", agentA !== "" && agentB !== "" && agentA !== agentB);
  check("the rival gets its own prompt ref", refA !== refB);

  const capsuleName = `${LABEL}.${env.parentName}`;
  const rows = (await sql`
    select agent_address, slot from capsule_secret where capsule_name = ${capsuleName} order by agent_address, slot
  `) as { agent_address: string; slot: string }[];
  check(
    "both proposals stored credentials, under different agents",
    new Set(rows.map((r) => r.agent_address)).size === 2 && rows.length === 4,
    `${rows.length} rows, ${new Set(rows.map((r) => r.agent_address)).size} agents`,
  );

  const agentRows = (await sql`
    select agent_address from capsule_agent where capsule_name = ${capsuleName}
  `) as { agent_address: string }[];
  check("both agent keys were stored", agentRows.length === 2, `${agentRows.length} rows`);

  // ---- 5. rate limiting ---------------------------------------------------
  console.log("\nrate limiting:");
  const attempts = (await sql`
    select count(*)::int as n from capsule_prepare_attempt where capsule_name = ${capsuleName}
  `) as { n: number }[];
  check("attempts are recorded", (attempts[0]?.n ?? 0) >= 2, `${attempts[0]?.n} rows`);

  const refused = (await sql`
    select count(*)::int as n from capsule_prepare_attempt
    where capsule_name = ${capsuleName} and accepted = false
  `) as { n: number }[];
  check(
    "refusals are recorded too",
    (refused[0]?.n ?? 0) >= 1,
    `${refused[0]?.n} refused rows — a caller that only ever failed would otherwise never be limited`,
  );

  console.log(
    `  note  limits are ${RATE_LIMITS.perOwner}/owner, ${RATE_LIMITS.perClient}/client,` +
      ` ${RATE_LIMITS.perGlobal} global per ${RATE_LIMITS.windowSeconds}s`,
  );

  // Does the limiter actually fire? Nothing above proves it does — every check
  // so far stayed under the ceiling, so a limiter that was silently disabled
  // would pass all of them.
  //
  // Rather than send 30 real requests (which would lock this machine out of the
  // endpoint for an hour), the window is filled directly. The client hash is
  // read back from the row the successful prepare just wrote, so this fills the
  // same bucket the server will count — computing it here would only prove the
  // test and the server agree about a hash, not that they agree about a client.
  const hashRows = (await sql`
    select client_hash from capsule_prepare_attempt
    where capsule_name = ${capsuleName} and accepted = true limit 1
  `) as { client_hash: string }[];
  const liveClientHash = hashRows[0]?.client_hash;
  check("the server recorded a client hash", typeof liveClientHash === "string" && liveClientHash !== "");

  if (typeof liveClientHash === "string") {
    const filler = `ratelimit-probe.${LABEL}`;

    // Counted rather than assumed: this bucket already holds every refusal the
    // authorisation section produced, and hardcoding a number here would make
    // the check fail whenever a case is added above.
    const beforeRows = (await sql`
      select count(*)::int as n from capsule_prepare_attempt where client_hash = ${liveClientHash}
    `) as { n: number }[];
    const before = beforeRows[0]?.n ?? 0;
    for (let i = 0; i < RATE_LIMITS.perClient; i += 1) {
      await sql`
        insert into capsule_prepare_attempt (owner_address, client_hash, capsule_name, accepted)
        values ('', ${liveClientHash}, ${filler}, false)
      `;
    }

    const overLimit = await send(privateKeyToAccount(generatePrivateKey()));
    check("the client limit actually fires", overLimit.status === 429, `got ${overLimit.status}`);
    check(
      "a limited response says when to retry",
      overLimit.body.retryAfterSeconds === RATE_LIMITS.windowSeconds,
      JSON.stringify(overLimit.body),
    );

    // And a refused-by-limit request must NOT add a row — otherwise the
    // limiter is itself the storage-fill vector it exists to prevent.
    const after = (await sql`
      select count(*)::int as n from capsule_prepare_attempt where client_hash = ${liveClientHash}
    `) as { n: number }[];
    check(
      "a rate-limited request writes no row",
      (after[0]?.n ?? 0) === before + RATE_LIMITS.perClient,
      `${after[0]?.n} rows, expected ${before + RATE_LIMITS.perClient} (${before} before + ${RATE_LIMITS.perClient} filler)`,
    );

    await sql`delete from capsule_prepare_attempt where capsule_name = ${filler}`;
  }

  // ---- cleanup ------------------------------------------------------------
  //
  // One statement per table rather than one per row: this runs against a
  // serverless Postgres over HTTP, where every query is a request that can fail
  // on its own, and a cleanup loop of twenty of them fails a check run for
  // reasons that have nothing to do with the code under test.
  const prefix = `${LABEL}%`;
  await sql`delete from capsule_secret where capsule_name like ${prefix}`;
  await sql`delete from capsule_agent  where capsule_name like ${prefix}`;
  await sql`delete from capsule_prompt where capsule_name like ${prefix}`;
  await sql`delete from capsule_prepare_attempt where capsule_name like ${prefix} or capsule_name like 'ratelimit-probe.%'`;

  const left = (await sql`
    select
      (select count(*) from capsule_agent  where capsule_name like ${prefix}) +
      (select count(*) from capsule_prompt where capsule_name like ${prefix}) +
      (select count(*) from capsule_secret where capsule_name like ${prefix}) +
      (select count(*) from capsule_prepare_attempt where capsule_name like ${prefix})
      as n
  `) as { n: string }[];
  check("\ncleaned up every table", Number(left[0]?.n ?? -1) === 0, `${left[0]?.n} rows left`);

  console.log("");
  if (failures > 0) {
    console.error(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("prepare route holds under all of the above.\n");
}

main().catch((error) => {
  console.error(`\nprepare check crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
