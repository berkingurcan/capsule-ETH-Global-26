/**
 * The model providers a capsule may run on.
 *
 * `agent-model` on chain is `<provider>/<model>` — OpenClaw's own model-reference
 * syntax, passed to the gateway verbatim as `agents.defaults.model.primary`. The
 * record is not ours to invent a format for; it is the gateway's, and writing the
 * gateway's spelling means a name stays legible to anyone who reads OpenClaw's
 * documentation instead of this repository's.
 *
 * Nothing here is on chain. `CapsuleMinter` writes `agent-model` as an opaque
 * string and validates nothing, deliberately: a new provider must be a new row in
 * this table, never a contract redeploy. That matters more than it sounds like it
 * does — redeploying the minter changes `REGISTRY_INTEROP_ADDRESS`, which changes
 * the ERC-7930 half of every ENSIP-25 `agent-registration[…][…]` key, which
 * silently invalidates the fixture in RECORDS.md and every name already minted.
 *
 * Spec: ../../Branding-ENSClaw/MULTI-MODEL.md
 *
 * The two TypeScript copies are byte-identical on purpose. The runner ships as an
 * independent container and cannot take a workspace dependency on the web app, so
 * the file is duplicated and `npm run check:records` (in web/) asserts the copies
 * still say the same thing.
 *
 *   runner/src/providers.ts        this file
 *   web/lib/capsule/providers.ts   a byte-identical copy
 */

/**
 * Built-in OpenClaw provider plugins.
 *
 * These publish their own model catalogs, so a capsule running on one needs no
 * `models.providers` entry at all — just the auth variable in the gateway's
 * environment and a model reference naming it.
 *
 * `envVar` is a lookup, never a derivation. Google's variable is `GEMINI_API_KEY`
 * and its provider id is `google`; `id.toUpperCase() + "_API_KEY"` would produce
 * `GOOGLE_API_KEY`, which OpenClaw reads only as a fallback. Two of these ids
 * disagree with their variable, which is one more than is needed to rule the
 * shortcut out.
 */
export const PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    example: "anthropic/claude-opus-5",
    keyHint: "sk-ant-…",
  },
  openai: {
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    example: "openai/gpt-5.6-sol",
    keyHint: "sk-…",
  },
  google: {
    label: "Google Gemini",
    envVar: "GEMINI_API_KEY",
    example: "google/gemini-3.1-pro-preview",
    keyHint: "AIza…",
  },
  deepseek: {
    label: "DeepSeek",
    envVar: "DEEPSEEK_API_KEY",
    example: "deepseek/deepseek-v4-flash",
    keyHint: "sk-…",
  },
  groq: {
    label: "Groq",
    envVar: "GROQ_API_KEY",
    example: "groq/llama-3.3-70b-versatile",
    keyHint: "gsk_…",
  },
  mistral: {
    label: "Mistral",
    envVar: "MISTRAL_API_KEY",
    example: "mistral/mistral-large-latest",
    keyHint: "",
  },
  xai: {
    label: "xAI",
    envVar: "XAI_API_KEY",
    example: "xai/grok-4.3",
    keyHint: "xai-…",
  },
  openrouter: {
    label: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    example: "openrouter/auto",
    keyHint: "sk-or-…",
  },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

export type ProviderSpec = {
  label: string;
  envVar: string;
  example: string;
  keyHint: string;
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isBuiltInProvider(id: string): id is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

/**
 * The catalog the launchpad offers, and the seeds for the fleet demo.
 *
 * Not exhaustive and not authoritative — OpenClaw's catalog is, and it moves
 * faster than a hackathon repository does. An owner may type any model their
 * provider serves; this list exists so the common case is two clicks.
 */
export const SUGGESTED_MODELS: Record<ProviderId, string[]> = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-5.6-sol", "gpt-5.5"],
  google: ["gemini-3.1-pro-preview", "gemini-3.5-flash"],
  deepseek: ["deepseek-v4-flash", "deepseek-v3.2"],
  groq: ["llama-3.3-70b-versatile"],
  mistral: ["mistral-large-latest"],
  xai: ["grok-4.3"],
  openrouter: ["auto"],
};

/**
 * The environment variable a custom provider's key is delivered in.
 *
 * A provider outside the table above is reached through OpenClaw's
 * `models.providers` block, whose `apiKey` field interpolates `${VAR}`. The
 * variable therefore has to be named deterministically on both sides, and it has
 * to be a legal shell identifier whatever the provider called itself.
 */
export function customEnvVar(provider: string): string {
  const sanitized = provider.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  return `CAPSULE_PROVIDER_${sanitized}_API_KEY`;
}

/** Where this provider's key is looked for in the gateway's environment. */
export function envVarFor(provider: string): string {
  return isBuiltInProvider(provider) ? PROVIDERS[provider].envVar : customEnvVar(provider);
}

////////////////////////////////////////////////////////////////////////////
// Model references
////////////////////////////////////////////////////////////////////////////

export type ModelRef = {
  /** The text before the first separator, e.g. "openrouter". */
  provider: string;
  /** Everything after it, separators included, e.g. "anthropic/claude-opus-5". */
  model: string;
  /** The original string, for logging and for handing back to the gateway. */
  ref: string;
};

/**
 * `"anthropic/claude-opus-5"` → `{ provider: "anthropic", model: "claude-opus-5" }`.
 *
 * **Splits on the first separator only.** Several real references carry more
 * than one — `openrouter/anthropic/claude-sonnet-4-6`, `nvidia/nvidia/nemotron-…`,
 * `chutes/zai-org/GLM-5-TEE` — and a `split("/")` that keeps `[0]` and `[1]`
 * yields a provider that exists and a model that does not. The failure surfaces
 * at the gateway as an unknown model, three layers from the parser that caused
 * it, which is the expensive kind of bug.
 *
 * Returns null rather than throwing: every caller has a different idea of what a
 * malformed reference means, and at least one of them must not treat it as fatal.
 */
export function parseModelRef(raw: string): ModelRef | null {
  const ref = raw.trim();
  const separator = ref.indexOf("/");
  if (separator <= 0) return null;

  const provider = ref.slice(0, separator);
  const model = ref.slice(separator + 1);
  if (model === "") return null;

  return { provider, model, ref };
}

/**
 * Everything wrong with a model reference, in the order an owner would fix it.
 *
 * Returns an empty array for a value this system can run. A reference to a
 * provider outside the table is *not* an error here — a custom provider is a
 * supported deployment, and whether its credential carries the `baseUrl` it needs
 * is a question for the credential, not for the string.
 */
export function modelRefProblems(raw: string): string[] {
  const parsed = parseModelRef(raw);
  if (parsed === null) {
    return [
      `"${raw}" is not <provider>/<model> — try ${PROVIDERS.anthropic.example}`,
    ];
  }
  return [];
}

////////////////////////////////////////////////////////////////////////////
// Credential slots
////////////////////////////////////////////////////////////////////////////

/**
 * The key under which a capsule's secrets are stored and served.
 *
 * One namespace for every kind, because the alternative is a table per secret
 * type and a migration every time an agent learns to hold something new. The
 * prefix is what keeps a provider called `telegram` from colliding with the bot
 * token.
 */
export const TELEGRAM_SLOT = "telegram";

export function providerSlot(provider: string): string {
  return `provider:${provider}`;
}

/** `"provider:openai"` → `"openai"`. Null for any other slot. */
export function providerFromSlot(slot: string): string | null {
  return slot.startsWith("provider:") ? slot.slice("provider:".length) : null;
}
