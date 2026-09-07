/**
 * The secret store. The only module that talks to Postgres, and the only one
 * that holds the master key.
 *
 * Two rules the API shape enforces rather than documents:
 *
 * 1. Prompt reads are scoped by (ref, capsule_name). Refs are published in an
 *    ENS text record, so they are public knowledge. A read that took only a ref
 *    would let any agent with a valid signature fetch any other agent's prompt
 *    — the signature proves who is asking, not what they may have. There is no
 *    readPromptByRef function, deliberately.
 *
 * 2. Agent private keys are never reachable from a caller-supplied ref. They
 *    are looked up by capsule name, from the provisioner only, and never
 *    travel over HTTP to anyone.
 *
 * Prompts are append-only. Changing an agent's instructions means creating a
 * new row and pointing the ENS record at the new ref, which costs the owner a
 * transaction. That is a feature: the pointer on chain stays the truth about
 * which prompt is live, and the change is publicly auditable.
 */
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { aad, open, seal } from "./crypto";
import type { ServerEnv } from "./env";

/** Attempts to find a free ref before giving up. Collisions are ~1 in 16.7M. */
const REF_ATTEMPTS = 5;

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export type Store = {
  sql: NeonQueryFunction<false, false>;
  key: Buffer;
};

export function createStore(env: ServerEnv): Store {
  return { sql: neon(env.databaseUrl), key: env.masterKey };
}

/**
 * "cap_" + 6 hex. Short because it is displayed and because it ends up in an
 * ENS record; low entropy is fine because it is not a credential. Uniqueness
 * is enforced by the primary key, not by the generator.
 */
function newRef(): string {
  return `cap_${randomBytes(3).toString("hex")}`;
}

////////////////////////////////////////////////////////////////////////////
// Prompts
////////////////////////////////////////////////////////////////////////////

export type StoredPrompt = {
  ref: string;
  capsuleName: string;
  body: string;
  createdAt: Date;
};

/**
 * Seals a prompt and returns the pointer to write on chain.
 *
 * Called before the mint, because `mint()` writes agent.prompt in the same
 * transaction that creates the name. The row is therefore unreachable until
 * the mint lands: the prompt service authorises against the name's addr
 * record, which does not resolve yet. No extra state is needed to express
 * "paid but not yet minted" — the chain expresses it.
 */
export async function createPrompt(
  store: Store,
  args: { capsuleName: string; body: string },
): Promise<{ ref: string }> {
  const capsuleName = args.capsuleName.toLowerCase();
  if (args.body.trim() === "") throw new StoreError("prompt body is empty");

  for (let attempt = 0; attempt < REF_ATTEMPTS; attempt += 1) {
    const ref = newRef();
    const sealed = seal(store.key, args.body, aad.prompt(ref, capsuleName));

    // ON CONFLICT DO NOTHING rather than a pre-flight SELECT: the check and the
    // insert would not be atomic, and two concurrent orders can generate the
    // same ref.
    const rows = (await store.sql`
      insert into capsule_prompt (ref, capsule_name, body_sealed)
      values (${ref}, ${capsuleName}, ${sealed})
      on conflict (ref) do nothing
      returning ref
    `) as { ref: string }[];

    if (rows.length === 1) return { ref };
  }

  throw new StoreError(`could not allocate a free prompt ref in ${REF_ATTEMPTS} attempts`);
}

/**
 * Reads a prompt, scoped to the capsule that owns it.
 *
 * Returns null for both "no such ref" and "that ref belongs to someone else",
 * so the caller cannot use this to enumerate which refs exist. The AAD check
 * inside open() is the second line of the same defence: even a row whose
 * capsule_name was edited in SQL will not decrypt.
 */
export async function readPrompt(
  store: Store,
  args: { ref: string; capsuleName: string },
): Promise<StoredPrompt | null> {
  const capsuleName = args.capsuleName.toLowerCase();

  const rows = (await store.sql`
    select ref, capsule_name, body_sealed, created_at
    from capsule_prompt
    where ref = ${args.ref} and capsule_name = ${capsuleName}
  `) as { ref: string; capsule_name: string; body_sealed: string; created_at: string }[];

  const row = rows[0];
  if (row === undefined) return null;

  const body = open(store.key, row.body_sealed, aad.prompt(row.ref, row.capsule_name));

  return {
    ref: row.ref,
    capsuleName: row.capsule_name,
    body,
    createdAt: new Date(row.created_at),
  };
}

////////////////////////////////////////////////////////////////////////////
// Agent keys
////////////////////////////////////////////////////////////////////////////

export type StoredAgent = {
  capsuleName: string;
  address: Address;
  privateKey: Hex;
};

/**
 * One agent EOA per capsule, written once.
 *
 * Kept rather than discarded after the machine boots so a runner can be
 * recreated — losing the key would mean the name permanently points at an
 * address nobody controls, and only a new mint could fix it.
 */
export async function createAgent(
  store: Store,
  args: { capsuleName: string; address: Address; privateKey: Hex },
): Promise<void> {
  const capsuleName = args.capsuleName.toLowerCase();
  const address = args.address.toLowerCase();
  const sealed = seal(store.key, args.privateKey, aad.agent(capsuleName, address));

  const rows = (await store.sql`
    insert into capsule_agent (capsule_name, agent_address, key_sealed)
    values (${capsuleName}, ${address}, ${sealed})
    on conflict (capsule_name) do nothing
    returning capsule_name
  `) as { capsule_name: string }[];

  if (rows.length === 0) {
    // A second key for a name whose addr record already points at the first one
    // would produce an agent that cannot authenticate. Refuse loudly.
    throw new StoreError(`${capsuleName} already has an agent key`);
  }
}

export async function readAgent(
  store: Store,
  args: { capsuleName: string },
): Promise<StoredAgent | null> {
  const capsuleName = args.capsuleName.toLowerCase();

  const rows = (await store.sql`
    select capsule_name, agent_address, key_sealed
    from capsule_agent
    where capsule_name = ${capsuleName}
  `) as { capsule_name: string; agent_address: string; key_sealed: string }[];

  const row = rows[0];
  if (row === undefined) return null;

  const privateKey = open(
    store.key,
    row.key_sealed,
    aad.agent(row.capsule_name, row.agent_address),
  ) as Hex;

  return {
    capsuleName: row.capsule_name,
    address: row.agent_address as Address,
    privateKey,
  };
}
