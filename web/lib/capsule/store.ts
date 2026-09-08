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
import { TELEGRAM_SLOT, providerSlot } from "./providers";

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
 * Called before the mint, because `mint()` writes agent-prompt in the same
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

////////////////////////////////////////////////////////////////////////////
// Credentials
////////////////////////////////////////////////////////////////////////////

/**
 * Non-secret detail about how a custom provider is reached.
 *
 * Empty for a built-in provider, which needs no endpoint configuration at all:
 * naming it in `agent-model` and putting its key in the gateway's environment is
 * the whole setup.
 */
export type CredentialMeta = {
  baseUrl?: string;
  api?: string;
};

export type StoredSecret = {
  capsuleName: string;
  slot: string;
  value: string;
  meta: CredentialMeta;
};

/**
 * Writes a secret, replacing whatever was in that slot.
 *
 * Unlike prompts, these are **not** append-only. A prompt is append-only because
 * the pointer on chain must keep naming exactly one body, and rewriting a body
 * in place would make the record lie about what the agent was told. A provider
 * key has no on-chain pointer and no audit value — it is a credential, rotating
 * one is the normal case, and keeping every previous key forever would be a
 * liability rather than a record.
 */
export async function putSecret(
  store: Store,
  args: { capsuleName: string; slot: string; value: string; meta?: CredentialMeta },
): Promise<void> {
  const capsuleName = args.capsuleName.toLowerCase();
  if (args.value.trim() === "") throw new StoreError(`${args.slot} value is empty`);

  const sealed = seal(store.key, args.value, aad.secret(capsuleName, args.slot));
  const meta = JSON.stringify(args.meta ?? {});

  await store.sql`
    insert into capsule_secret (capsule_name, slot, value_sealed, meta)
    values (${capsuleName}, ${args.slot}, ${sealed}, ${meta}::jsonb)
    on conflict (capsule_name, slot) do update
      set value_sealed = excluded.value_sealed,
          meta         = excluded.meta,
          updated_at   = now()
  `;
}

export async function readSecret(
  store: Store,
  args: { capsuleName: string; slot: string },
): Promise<StoredSecret | null> {
  const capsuleName = args.capsuleName.toLowerCase();

  const rows = (await store.sql`
    select capsule_name, slot, value_sealed, meta
    from capsule_secret
    where capsule_name = ${capsuleName} and slot = ${args.slot}
  `) as { capsule_name: string; slot: string; value_sealed: string; meta: CredentialMeta }[];

  const row = rows[0];
  if (row === undefined) return null;

  return {
    capsuleName: row.capsule_name,
    slot: row.slot,
    value: open(store.key, row.value_sealed, aad.secret(row.capsule_name, row.slot)),
    meta: row.meta ?? {},
  };
}

/**
 * Which slots a capsule has filled — names only, nothing decrypted.
 *
 * The launchpad's edit view needs to show "you have keys for anthropic and
 * google" without any secret leaving Postgres, and the check is cheap enough to
 * run on a page render.
 */
export async function listSecretSlots(
  store: Store,
  args: { capsuleName: string },
): Promise<string[]> {
  const capsuleName = args.capsuleName.toLowerCase();

  const rows = (await store.sql`
    select slot from capsule_secret
    where capsule_name = ${capsuleName}
    order by slot
  `) as { slot: string }[];

  return rows.map((row) => row.slot);
}

/** Convenience wrappers, so callers never assemble a slot string themselves. */
export const secrets = {
  putProviderKey: (
    store: Store,
    args: { capsuleName: string; provider: string; apiKey: string; meta?: CredentialMeta },
  ) =>
    putSecret(store, {
      capsuleName: args.capsuleName,
      slot: providerSlot(args.provider),
      value: args.apiKey,
      meta: args.meta,
    }),

  readProviderKey: (store: Store, args: { capsuleName: string; provider: string }) =>
    readSecret(store, { capsuleName: args.capsuleName, slot: providerSlot(args.provider) }),

  putTelegramToken: (store: Store, args: { capsuleName: string; token: string }) =>
    putSecret(store, { capsuleName: args.capsuleName, slot: TELEGRAM_SLOT, value: args.token }),

  readTelegramToken: (store: Store, args: { capsuleName: string }) =>
    readSecret(store, { capsuleName: args.capsuleName, slot: TELEGRAM_SLOT }),
};
