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
 *    are looked up by (capsule name, agent address), from the provisioner only,
 *    and never travel over HTTP to anyone.
 *
 * 3. Every row written before a mint is scoped by the agent address it was
 *    generated for, never by the capsule name alone. `mint()` is permissionless,
 *    so before the transaction lands nobody owns the name and any number of
 *    people may have proposed one. Keying on the name would let the first
 *    proposal block every later one, and — worse — let a later one overwrite an
 *    earlier one's credentials. See db/migrations/003_prepare_before_mint.sql.
 *
 * Prompts are append-only. Changing an agent's instructions means creating a
 * new row and pointing the ENS record at the new ref, which costs the owner a
 * transaction. That is a feature: the pointer on chain stays the truth about
 * which prompt is live, and the change is publicly auditable.
 */
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { createHmac, randomBytes } from "node:crypto";
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
 * One key per (capsule, agent), written once.
 *
 * NOT one per capsule. Several people may propose an agent for the same
 * unminted label, and the chain decides between them: whichever address the
 * mint writes into `addr` is the agent, and the rest are rows nothing ever
 * addresses. Refusing the second proposal — which is what a name-only key did —
 * turned a free HTTP request into a permanent hold on a label that was still
 * available on chain.
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
    on conflict (capsule_name, agent_address) do nothing
    returning capsule_name
  `) as { capsule_name: string }[];

  if (rows.length === 0) {
    // The same address proposed twice for the same name. Not an attack and not
    // recoverable by writing again: the stored key is already the right one.
    throw new StoreError(`${capsuleName} already has a key for ${address}`);
  }
}

/**
 * The private key for one agent on one capsule.
 *
 * Takes the address rather than deriving it, because the caller's whole reason
 * to be here is that it read `addr` off the chain. That read IS the
 * authorisation: this function answers "give me the key for the agent this name
 * publicly claims", and there is deliberately no way to ask "give me whatever
 * key you have for this name".
 */
export async function readAgent(
  store: Store,
  args: { capsuleName: string; address: Address },
): Promise<StoredAgent | null> {
  const capsuleName = args.capsuleName.toLowerCase();
  const address = args.address.toLowerCase();

  const rows = (await store.sql`
    select capsule_name, agent_address, key_sealed
    from capsule_agent
    where capsule_name = ${capsuleName} and agent_address = ${address}
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
  agentAddress: Address;
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
  args: { capsuleName: string; agentAddress: Address; slot: string; value: string; meta?: CredentialMeta },
): Promise<void> {
  const capsuleName = args.capsuleName.toLowerCase();
  const agentAddress = args.agentAddress.toLowerCase();
  if (args.value.trim() === "") throw new StoreError(`${args.slot} value is empty`);

  const sealed = seal(store.key, args.value, aad.secret(capsuleName, agentAddress, args.slot));
  const meta = JSON.stringify(args.meta ?? {});

  // Still an upsert, but now only within one agent's own rows: rotating a key
  // replaces it, and a different agent's proposal for the same label lands in a
  // different row rather than on top of this one.
  await store.sql`
    insert into capsule_secret (capsule_name, agent_address, slot, value_sealed, meta)
    values (${capsuleName}, ${agentAddress}, ${args.slot}, ${sealed}, ${meta}::jsonb)
    on conflict (capsule_name, agent_address, slot) do update
      set value_sealed = excluded.value_sealed,
          meta         = excluded.meta,
          updated_at   = now()
  `;
}

export async function readSecret(
  store: Store,
  args: { capsuleName: string; agentAddress: Address; slot: string },
): Promise<StoredSecret | null> {
  const capsuleName = args.capsuleName.toLowerCase();
  const agentAddress = args.agentAddress.toLowerCase();

  const rows = (await store.sql`
    select capsule_name, agent_address, slot, value_sealed, meta
    from capsule_secret
    where capsule_name = ${capsuleName}
      and agent_address = ${agentAddress}
      and slot = ${args.slot}
  `) as {
    capsule_name: string;
    agent_address: string;
    slot: string;
    value_sealed: string;
    meta: CredentialMeta;
  }[];

  const row = rows[0];
  if (row === undefined) return null;

  return {
    capsuleName: row.capsule_name,
    agentAddress: row.agent_address as Address,
    slot: row.slot,
    value: open(store.key, row.value_sealed, aad.secret(row.capsule_name, row.agent_address, row.slot)),
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
  args: { capsuleName: string; agentAddress: Address },
): Promise<string[]> {
  const capsuleName = args.capsuleName.toLowerCase();
  const agentAddress = args.agentAddress.toLowerCase();

  const rows = (await store.sql`
    select slot from capsule_secret
    where capsule_name = ${capsuleName} and agent_address = ${agentAddress}
    order by slot
  `) as { slot: string }[];

  return rows.map((row) => row.slot);
}

/** Convenience wrappers, so callers never assemble a slot string themselves. */
export const secrets = {
  putProviderKey: (
    store: Store,
    args: {
      capsuleName: string;
      agentAddress: Address;
      provider: string;
      apiKey: string;
      meta?: CredentialMeta;
    },
  ) =>
    putSecret(store, {
      capsuleName: args.capsuleName,
      agentAddress: args.agentAddress,
      slot: providerSlot(args.provider),
      value: args.apiKey,
      meta: args.meta,
    }),

  readProviderKey: (
    store: Store,
    args: { capsuleName: string; agentAddress: Address; provider: string },
  ) =>
    readSecret(store, {
      capsuleName: args.capsuleName,
      agentAddress: args.agentAddress,
      slot: providerSlot(args.provider),
    }),

  putTelegramToken: (
    store: Store,
    args: { capsuleName: string; agentAddress: Address; token: string },
  ) =>
    putSecret(store, {
      capsuleName: args.capsuleName,
      agentAddress: args.agentAddress,
      slot: TELEGRAM_SLOT,
      value: args.token,
    }),

  readTelegramToken: (store: Store, args: { capsuleName: string; agentAddress: Address }) =>
    readSecret(store, {
      capsuleName: args.capsuleName,
      agentAddress: args.agentAddress,
      slot: TELEGRAM_SLOT,
    }),
};

////////////////////////////////////////////////////////////////////////////
// Prepare — the pre-mint write, and what bounds it
////////////////////////////////////////////////////////////////////////////

/**
 * Everything a prepare stores, in one transaction.
 *
 * Atomic because the four rows are only meaningful together. A capsule with an
 * agent key and no prompt row mints fine and then fails to boot, with the
 * failure surfacing in a container log hours later; a capsule with a prompt and
 * no key cannot be provisioned at all. Neither is dangerous — nothing can read
 * these rows until a mint names them — but both are the kind of debris that
 * makes a later bug hard to read.
 *
 * The ref is generated here rather than by `createPrompt` because the whole
 * write has to go in one `transaction([...])` call, which takes a fixed array of
 * queries and cannot branch on a result. A ref collision therefore fails the
 * transaction, and the caller retries with a new one — see `prepareCapsule`.
 */
export type PreparedCapsule = {
  capsuleName: string;
  owner: Address;
  agentAddress: Address;
  agentPrivateKey: Hex;
  promptBody: string;
  provider: string;
  providerKey: string;
  providerMeta?: CredentialMeta;
  telegramToken: string;
};

export async function prepareCapsule(
  store: Store,
  args: PreparedCapsule,
): Promise<{ promptRef: string }> {
  const capsuleName = args.capsuleName.toLowerCase();
  const agentAddress = args.agentAddress.toLowerCase();

  for (let attempt = 0; attempt < REF_ATTEMPTS; attempt += 1) {
    const ref = newRef();

    const providerMeta = JSON.stringify(args.providerMeta ?? {});
    const queries = [
      store.sql`
        insert into capsule_agent (capsule_name, agent_address, key_sealed)
        values (${capsuleName}, ${agentAddress}, ${seal(
          store.key,
          args.agentPrivateKey,
          aad.agent(capsuleName, agentAddress),
        )})
      `,
      store.sql`
        insert into capsule_prompt (ref, capsule_name, body_sealed)
        values (${ref}, ${capsuleName}, ${seal(
          store.key,
          args.promptBody,
          aad.prompt(ref, capsuleName),
        )})
      `,
      store.sql`
        insert into capsule_secret (capsule_name, agent_address, slot, value_sealed, meta)
        values (${capsuleName}, ${agentAddress}, ${providerSlot(args.provider)}, ${seal(
          store.key,
          args.providerKey,
          aad.secret(capsuleName, agentAddress, providerSlot(args.provider)),
        )}, ${providerMeta}::jsonb)
      `,
      store.sql`
        insert into capsule_secret (capsule_name, agent_address, slot, value_sealed, meta)
        values (${capsuleName}, ${agentAddress}, ${TELEGRAM_SLOT}, ${seal(
          store.key,
          args.telegramToken,
          aad.secret(capsuleName, agentAddress, TELEGRAM_SLOT),
        )}, '{}'::jsonb)
      `,
    ];

    try {
      await store.sql.transaction(queries);
      return { promptRef: ref };
    } catch (error) {
      // 23505 is unique_violation. On the prompt ref it is a collision worth
      // retrying; on the agent rows it means this exact agent address was
      // already prepared for this name, which a fresh keypair makes impossible
      // and so indicates a caller replaying its own request.
      const code = (error as { code?: string }).code;
      if (code === "23505" && attempt < REF_ATTEMPTS - 1) continue;
      throw error instanceof Error ? error : new StoreError(String(error));
    }
  }

  throw new StoreError(`could not allocate a free prompt ref in ${REF_ATTEMPTS} attempts`);
}

/**
 * An HMAC of the client address, so a rate limit can count without keeping a
 * visitor log.
 *
 * The master key is the HMAC key, which means these values rotate with it and
 * are useless to anyone who gets the table without it. A plain hash would not
 * do: the input space is small enough that an unkeyed digest of an IPv4 address
 * is reversible by brute force in seconds.
 */
export function clientHash(store: Store, client: string): string {
  return createHmac("sha256", store.key).update(client).digest("base64url").slice(0, 32);
}

export type RateWindow = { owner: number; client: number; global: number };

/** How many attempts each bucket has made inside the window. One query. */
export async function countRecentPrepares(
  store: Store,
  args: { ownerAddress: string; clientHash: string; windowSeconds: number },
): Promise<RateWindow> {
  const since = new Date(Date.now() - args.windowSeconds * 1000).toISOString();
  const owner = args.ownerAddress.toLowerCase();

  const rows = (await store.sql`
    select
      count(*) filter (where owner_address = ${owner})       as owner_count,
      count(*) filter (where client_hash   = ${args.clientHash}) as client_count,
      count(*)                                                as global_count
    from capsule_prepare_attempt
    where created_at > ${since}
  `) as { owner_count: string; client_count: string; global_count: string }[];

  const row = rows[0];
  return {
    owner: Number(row?.owner_count ?? 0),
    client: Number(row?.client_count ?? 0),
    global: Number(row?.global_count ?? 0),
  };
}

/**
 * Records an attempt, accepted or not.
 *
 * Refusals count against the limit on purpose. If only successes were recorded,
 * a caller could sit just under the ceiling forever by sending requests that
 * fail validation — which are just as expensive to serve and are what an attack
 * looks like anyway.
 */
export async function recordPrepareAttempt(
  store: Store,
  args: { ownerAddress: string; clientHash: string; capsuleName: string; accepted: boolean },
): Promise<void> {
  await store.sql`
    insert into capsule_prepare_attempt (owner_address, client_hash, capsule_name, accepted)
    values (${args.ownerAddress.toLowerCase()}, ${args.clientHash}, ${args.capsuleName.toLowerCase()}, ${args.accepted})
  `;
}
