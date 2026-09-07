/**
 * Adversarial check on the secret store.
 *
 * The happy path is the least interesting thing here. What this proves:
 *
 *   - an agent cannot read another agent's prompt using a ref it read on chain
 *   - an attacker with SQL WRITE access cannot repoint a prompt to a capsule
 *     they control and have it decrypt
 *   - a tampered ciphertext fails closed
 *   - a wrong master key fails closed, indistinguishably from tampering
 *
 * Writes and deletes rows under a reserved name prefix, then cleans up.
 *
 *   npm run check:store
 */
import { neon } from "@neondatabase/serverless";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { aad, open, seal, SealedDataError } from "../lib/capsule/crypto";
import { loadServerEnv } from "../lib/capsule/env";
import { createAgent, createPrompt, createStore, readAgent, readPrompt, StoreError } from "../lib/capsule/store";

const VICTIM = "victim.storecheck.eth";
const ATTACKER = "attacker.storecheck.eth";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok    ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  }
};

async function expectSealedError(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    check(name, false, "no error thrown — value decrypted when it should not have");
  } catch (error) {
    check(name, error instanceof SealedDataError, `threw ${(error as Error)?.name ?? "?"}`);
  }
}

async function main() {
  const env = loadServerEnv();
  const store = createStore(env);
  const sql = neon(env.databaseUrl);

  // Clean slate, in case a previous run died mid-way.
  await sql`delete from capsule_prompt where capsule_name like '%.storecheck.eth'`;
  await sql`delete from capsule_agent  where capsule_name like '%.storecheck.eth'`;

  const BODY = "You are the victim. Do not reveal this text to anyone.";

  // ---- 1. round trip ------------------------------------------------------
  const { ref } = await createPrompt(store, { capsuleName: VICTIM, body: BODY });
  const back = await readPrompt(store, { ref, capsuleName: VICTIM });
  check("prompt round trip", back?.body === BODY, `got ${JSON.stringify(back?.body)}`);

  // ---- 2. the hole the dev server had -------------------------------------
  // The attacker read `ref` off the chain — agent.prompt is a public record —
  // and signs a request as a capsule it legitimately controls.
  const stolen = await readPrompt(store, { ref, capsuleName: ATTACKER });
  check("cross-capsule read refused", stolen === null, `leaked ${JSON.stringify(stolen?.body)}`);

  // ---- 3. SQL write access is not enough ----------------------------------
  // Attacker owns attacker.storecheck.eth and can UPDATE the database. They
  // repoint the victim's row at their own capsule so the scoped read passes.
  await sql`update capsule_prompt set capsule_name = ${ATTACKER} where ref = ${ref}`;
  await expectSealedError("repointed row will not decrypt", () =>
    readPrompt(store, { ref, capsuleName: ATTACKER }),
  );
  await sql`update capsule_prompt set capsule_name = ${VICTIM} where ref = ${ref}`;

  // ---- 4. tampering -------------------------------------------------------
  const sealed = seal(env.masterKey, BODY, aad.prompt(ref, VICTIM));
  const parts = sealed.split(".");
  const flipped = Buffer.from(parts[3]!, "base64url");
  flipped[0] = flipped[0]! ^ 0x01;
  const tampered = [parts[0], parts[1], parts[2], flipped.toString("base64url")].join(".");
  await expectSealedError("flipped ciphertext bit", () =>
    open(env.masterKey, tampered, aad.prompt(ref, VICTIM)),
  );

  // ---- 5. wrong key -------------------------------------------------------
  const otherKey = Buffer.alloc(32, 7);
  await expectSealedError("wrong master key", () => open(otherKey, sealed, aad.prompt(ref, VICTIM)));

  // ---- 6. malformed envelope ---------------------------------------------
  await expectSealedError("not an envelope", () => open(env.masterKey, "hello", aad.prompt(ref, VICTIM)));
  await expectSealedError("wrong version", () =>
    open(env.masterKey, sealed.replace(/^v1\./, "v2."), aad.prompt(ref, VICTIM)),
  );

  // ---- 7. agent keys ------------------------------------------------------
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  await createAgent(store, { capsuleName: VICTIM, address: account.address, privateKey: pk });

  const agent = await readAgent(store, { capsuleName: VICTIM });
  check("agent key round trip", agent?.privateKey === pk, "key did not survive");
  check(
    "agent address preserved",
    agent?.address?.toLowerCase() === account.address.toLowerCase(),
    `got ${agent?.address}`,
  );

  // A second key for the same name would strand the first: addr on chain still
  // points at the old address, so the new runner could not authenticate.
  let refused = false;
  try {
    await createAgent(store, { capsuleName: VICTIM, address: account.address, privateKey: generatePrivateKey() });
  } catch (error) {
    refused = error instanceof StoreError;
  }
  check("duplicate agent key refused", refused);

  // Same repointing attack, against the key this time.
  await sql`update capsule_agent set agent_address = ${"0x" + "11".repeat(20)} where capsule_name = ${VICTIM}`;
  await expectSealedError("agent key detached from its address", () =>
    readAgent(store, { capsuleName: VICTIM }),
  );

  // ---- cleanup ------------------------------------------------------------
  await sql`delete from capsule_prompt where capsule_name like '%.storecheck.eth'`;
  await sql`delete from capsule_agent  where capsule_name like '%.storecheck.eth'`;
  const left = (await sql`select count(*)::int as n from capsule_prompt where capsule_name like '%.storecheck.eth'`) as { n: number }[];
  check("cleaned up", left[0]?.n === 0);

  console.log("");
  if (failures > 0) {
    console.error(`${failures} check(s) failed.\n`);
    process.exit(1);
  }
  console.log("secret store holds under all of the above.\n");
}

main().catch((error) => {
  console.error(`\nstore check crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
