-- The credentials the OpenClaw runtime needs, which the chain must never carry.
--
-- Two of them, both the owner's own property: the Telegram bot token they created, and a
-- model provider API key. The ENS name publishes the bot's public `t.me` URL as
-- `agent-endpoint[web]` and nothing else — a token in a text record is a token published
-- to everyone forever, and ENS records are not revocable in the way a leak requires.
--
-- These rows are reachable only over `GET /api/runtime`, which authorises exactly the way
-- the prompt route does: the caller signs with the agent key, the route recovers the
-- signer, and the name's `addr` record decides. There is still no credential issued to an
-- agent — the key it signs with is the identity ENS already published.

create table if not exists capsule_credential (
  -- One row per capsule per kind, e.g. ("analyst.capsulefleet.eth", "telegram-bot-token").
  capsule_name  text not null,

  -- 'telegram-bot-token' | 'model-api-key'. Not an enum: adding a kind should be an
  -- insert, not a migration that locks the table.
  kind          text not null,

  -- v1.<iv>.<tag>.<ciphertext>, base64url. AAD is
  -- "capsule_credential:<capsule_name>:<kind>", so a ciphertext moved between rows or
  -- between kinds stops opening.
  value_sealed  text not null,

  key_version   integer not null default 1,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  primary key (capsule_name, kind)
);

--> break

-- Non-secret runtime settings, kept beside the credentials so one query serves the whole
-- boot. `model_provider` decides which environment variable the gateway is handed;
-- `telegram_allow_from` is the list of numeric Telegram user ids permitted to DM the bot.
--
-- The allowlist is not a convenience. An agent whose bot anyone can DM is a
-- prompt-injection surface reachable from a search box, and ENS cannot defend against
-- that — the injected instruction never touches a record. The supervisor refuses to open
-- the channel when this is empty.
create table if not exists capsule_runtime (
  capsule_name         text primary key,
  model_provider       text not null,
  telegram_allow_from  text[] not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
