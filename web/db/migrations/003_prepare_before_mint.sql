-- Everything written before a mint is a *proposal*, not a claim.
--
-- `CapsuleMinter.mint()` is permissionless: anyone may mint any free label under
-- the parent and name themselves its owner. The launchpad has to write rows
-- before that transaction exists — the agent's key and the prompt ref are
-- arguments to the mint — which means, until 003, the database was strictly more
-- restrictive than the chain it is supposed to describe. Two holes came out of
-- that, and both are fixed by the same idea.
--
--   1. Squatting. `capsule_agent` was keyed by capsule_name alone and refused a
--      second row, so anyone who POSTed a prepare for "trader" first made that
--      label permanently unlaunchable for everyone else — free, instant, and
--      repeatable across the whole namespace, against a chain where the label
--      was still available.
--
--   2. Credential substitution, which is worse. `capsule_secret` was keyed by
--      (capsule_name, slot) and upserted, so a later prepare overwrote an
--      earlier one's bot token. The victim mints with their own agent address,
--      boots, asks /api/runtime for its Telegram token — and is handed the
--      attacker's. Their agent then answers on a bot they do not control.
--
-- The fix is to namespace pre-mint rows by the agent address, which is
-- server-generated, unguessable, and — crucially — the value the winning mint
-- publishes on chain as `addr`. Losing proposals keep their rows and are simply
-- never addressed by anything: /api/runtime recovers the agent address from the
-- request signature, checks it against `addr`, and reads only that agent's rows.
--
-- The chain stays the authorisation database. This migration just stops the
-- store from answering a question the chain had not been asked yet.
--
-- Statements are separated by a line containing only `--> break`.

-- capsule_agent: one key per (name, agent), not one per name. Several proposals
-- may exist for a label; the mint decides which one the chain names.
alter table capsule_agent drop constraint if exists capsule_agent_pkey;

--> break

alter table capsule_agent add primary key (capsule_name, agent_address);

--> break

-- capsule_secret: the same namespacing. The column carries a default only so the
-- statement is safe against a deployment that already has rows; it is dropped
-- immediately, because a secret with no agent is not a thing this system stores.
alter table capsule_secret add column if not exists agent_address text not null default '';

--> break

alter table capsule_secret alter column agent_address drop default;

--> break

alter table capsule_secret drop constraint if exists capsule_secret_pkey;

--> break

alter table capsule_secret add primary key (capsule_name, agent_address, slot);

--> break

drop index if exists capsule_secret_by_name;

--> break

-- "What can this agent run on?" — the runtime route's lookup, now scoped to the
-- agent the chain names rather than to the name alone.
create index if not exists capsule_secret_by_agent
  on capsule_secret (capsule_name, agent_address, slot);

--> break

-- Rate limiting for POST /api/capsule/prepare, which writes before any
-- transaction exists and is therefore the one endpoint an attacker can make
-- work without spending anything.
--
-- A signature binds each attempt to an address, but addresses are free to
-- generate, so the signature alone bounds nothing. This table is what actually
-- bounds it. It is in Postgres rather than in memory because the route runs
-- serverless: a per-instance counter resets on every cold start and is not
-- shared between concurrent instances, which makes it a limit in name only.
create table if not exists capsule_prepare_attempt (
  id            bigserial primary key,

  -- The address that signed the request. Lowercased.
  owner_address text not null,

  -- HMAC of the client IP under the master key, never the IP itself. We need to
  -- count requests from one source without keeping a log of who visited: the
  -- value is comparable and not reversible, and it rotates if the key does.
  client_hash   text not null,

  -- Which label was being prepared. Kept for a per-label limit and for working
  -- out, after the fact, whether a burst was one person retrying or an attack.
  capsule_name  text not null,

  -- False when the attempt was refused. Refusals are recorded too, or a caller
  -- could stay under the limit forever by making requests that always fail.
  accepted      boolean not null default true,

  created_at    timestamptz not null default now()
);

--> break

create index if not exists capsule_prepare_by_owner
  on capsule_prepare_attempt (owner_address, created_at desc);

--> break

create index if not exists capsule_prepare_by_client
  on capsule_prepare_attempt (client_hash, created_at desc);

--> break

create index if not exists capsule_prepare_by_time
  on capsule_prepare_attempt (created_at desc);
