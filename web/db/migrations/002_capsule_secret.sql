-- The credentials a capsule's gateway needs to be the agent its name claims.
--
-- `agent-model` on chain is `<provider>/<model>`. The provider half is public
-- and the key behind it is not, so the key lives here, sealed, and is served
-- over the same signed request that already serves the prompt.
--
-- One table with a `slot` column rather than a table per secret kind. A capsule
-- holds a bot token and a key for each provider its owner wants it to be able to
-- run on, and that set grows: a table per kind means a migration every time an
-- agent learns to hold something new.
--
-- Statements are separated by a line containing only `--> break`.

create table if not exists capsule_secret (
  -- e.g. "analyst.capsulefleet.eth". Lowercased by the caller, as everywhere.
  capsule_name  text not null,

  -- What this secret is for:
  --   'telegram'            the owner's bot token
  --   'provider:anthropic'  that provider's API key
  --   'provider:deepseek'   …and so on, one row per provider
  --
  -- The `provider:` prefix is load-bearing: without it a provider that called
  -- itself "telegram" would collide with the bot token in the same namespace.
  slot          text not null,

  -- v1.<iv>.<tag>.<ciphertext>, base64url. AAD is
  -- "capsule_secret:<capsule_name>:<slot>", so a ciphertext moved to another
  -- row — another capsule, or another provider on the same capsule — stops
  -- opening. The same binding the prompt and agent-key tables already use.
  value_sealed  text not null,

  -- NOT secret, and deliberately outside the envelope: `baseUrl` and `api` for a
  -- provider outside OpenClaw's built-in table. They are how an endpoint is
  -- reached rather than permission to reach it, they are needed to build the
  -- gateway config, and sealing them would mean decrypting a row to answer a
  -- question that does not require the key.
  meta          jsonb not null default '{}'::jsonb,

  key_version   integer not null default 1,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  primary key (capsule_name, slot)
);

--> break

-- "What can this capsule currently run on?" — the launchpad's edit view, and the
-- runtime route's lookup when the model record names a provider.
create index if not exists capsule_secret_by_name
  on capsule_secret (capsule_name, slot);
