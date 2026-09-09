/**
 * What a prepare request may contain, and what it may not.
 *
 * Kept out of the route so it can be tested without a database, a chain or an
 * HTTP server — every rule below is a pure function of the request. The route
 * is then just the order the checks run in and the writes that follow.
 *
 * Two kinds of rule live here and they exist for different reasons:
 *
 *   - **Shape.** A value that would make the mint revert, or that the runner
 *     could not boot on. Catching it here turns a failed transaction the owner
 *     paid gas for into a form error they can fix.
 *
 *   - **Size.** This endpoint writes to our database before anyone has spent
 *     anything, so every field it stores is a place to put bytes for free. The
 *     caps are generous for real use and ruinous for a storage-fill attack.
 */
import { getAddress, isAddress, type Address } from "viem";
import { normalize } from "viem/ens";
import { modelRefProblems, parseModelRef } from "./providers";

/** The only runtime a capsule can actually be booted on today. */
export const SUPPORTED_RUNTIME = "openclaw";

/**
 * Field limits.
 *
 * The on-chain ones are advisory — the owner pays for their own calldata, and
 * `CapsuleMinter` validates none of it — but a 40 KB `agent-context` is a
 * mistake rather than an intention, and it is cheaper to refuse it than to let
 * someone discover it after the gas is spent. The off-chain ones are load
 * bearing: they bound what an unauthenticated-in-practice caller can store.
 */
export const LIMITS = {
  /** DNS wire format gives one length byte per label. The contract agrees. */
  label: 63,
  context: 1000,
  telegramUrl: 400,
  model: 200,
  runtime: 64,
  /** A system prompt. Long enough for a real persona, short enough to bound. */
  prompt: 20_000,
  telegramToken: 200,
  providerKey: 500,
  providerBaseUrl: 400,
  providerApi: 64,
} as const;

export type PrepareRequest = {
  label: string;
  owner: Address;
  context: string;
  telegramUrl: string;
  model: string;
  runtime: string;
  prompt: string;
  telegramToken: string;
  providerKey: string;
  providerMeta?: { baseUrl?: string; api?: string };
};

export type PrepareProblem = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Label rules, stricter than the contract's.
 *
 * `CapsuleMinter.dnsNameOf` checks only that the label is 1–63 bytes, so the
 * contract would happily register "Trader" or "a b". Both are traps rather than
 * features: ENS normalisation lowercases the first, so the name the owner reads
 * back is not the one they typed, and the second cannot be typed into a DNS
 * label at all. Refusing them here costs nothing and means the label in the
 * form is exactly the label on chain.
 */
export function labelProblems(label: string): string[] {
  const problems: string[] = [];
  if (label === "") return ["a label is required"];
  if (label.length > LIMITS.label) problems.push(`must be ${LIMITS.label} characters or fewer`);
  if (/[A-Z]/.test(label)) {
    problems.push("must be lowercase — ENS normalisation would silently rewrite it");
  }
  if (!/^[a-z0-9-]+$/.test(label.toLowerCase())) {
    problems.push("may contain only lowercase letters, digits and hyphens");
  }
  if (label.startsWith("-") || label.endsWith("-")) problems.push("may not start or end with a hyphen");

  // The belt to the braces above: whatever our regex thinks, the name we build
  // has to survive the same normalisation `encodeName` applies, or the node we
  // compute is not the node the resolver stores.
  if (problems.length === 0) {
    try {
      if (normalize(label) !== label) problems.push("is not in normalised ENS form");
    } catch {
      problems.push("is not a valid ENS label");
    }
  }
  return problems;
}

/**
 * A Telegram bot token, shaped `<bot id>:<secret>`.
 *
 * Checked because the failure is otherwise invisible and late: a malformed
 * token is accepted here, sealed, written, minted around, and then produces a
 * gateway that starts and never answers — which looks exactly like a recall.
 * The one thing this system must never make ambiguous is why a bot went quiet.
 */
export function telegramTokenProblems(token: string): string[] {
  if (token === "") return ["a bot token is required"];
  if (token.length > LIMITS.telegramToken) return ["is longer than a Telegram token"];
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    return ["does not look like a Telegram bot token (<bot id>:<secret>)"];
  }
  return [];
}

/**
 * Validates and normalises a request body.
 *
 * Returns every problem at once rather than the first, because the caller is a
 * form and a person fixing one field at a time through six round trips is a
 * worse experience than the validation is worth.
 */
export function parsePrepareRequest(
  body: unknown,
  parentName: string,
): { ok: true; request: PrepareRequest; capsuleName: string } | { ok: false; problems: PrepareProblem[] } {
  const problems: PrepareProblem[] = [];
  if (!isRecord(body)) return { ok: false, problems: [{ field: "body", message: "expected a JSON object" }] };

  // Validated as typed, NOT lowercased first. Silently rewriting "Trader" to
  // "trader" would mean the label the caller sent is not the label that gets
  // minted, and the first time they notice is when they read the name back off
  // the chain. The form lowercases as you type; the API says what it did not
  // accept.
  const label = str(body, "label");
  for (const message of labelProblems(label)) problems.push({ field: "label", message });

  const rawOwner = str(body, "owner");
  let owner: Address = "0x0000000000000000000000000000000000000000";
  if (!isAddress(rawOwner)) {
    problems.push({ field: "owner", message: "is not an EVM address" });
  } else {
    owner = getAddress(rawOwner);
  }

  const context = str(body, "context");
  if (context === "") problems.push({ field: "context", message: "is required — it is what ENSIP-26 clients show" });
  else if (context.length > LIMITS.context) {
    problems.push({ field: "context", message: `must be ${LIMITS.context} characters or fewer` });
  }

  const telegramUrl = str(body, "telegramUrl");
  if (telegramUrl.length > LIMITS.telegramUrl) {
    problems.push({ field: "telegramUrl", message: `must be ${LIMITS.telegramUrl} characters or fewer` });
  } else if (telegramUrl !== "") {
    try {
      const url = new URL(telegramUrl);
      if (url.protocol !== "https:") problems.push({ field: "telegramUrl", message: "must be https" });
    } catch {
      problems.push({ field: "telegramUrl", message: "is not a URL" });
    }
  }

  const model = str(body, "model");
  if (model.length > LIMITS.model) {
    problems.push({ field: "model", message: `must be ${LIMITS.model} characters or fewer` });
  } else {
    for (const message of modelRefProblems(model)) problems.push({ field: "model", message });
  }

  // Defaulted rather than required. It is the one field with exactly one legal
  // value today, and making the caller send a constant is a way to get it wrong.
  const runtime = str(body, "runtime") || SUPPORTED_RUNTIME;
  if (runtime !== SUPPORTED_RUNTIME) {
    problems.push({ field: "runtime", message: `must be "${SUPPORTED_RUNTIME}" — nothing else can boot a capsule` });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (prompt.trim() === "") problems.push({ field: "prompt", message: "is required" });
  else if (prompt.length > LIMITS.prompt) {
    problems.push({ field: "prompt", message: `must be ${LIMITS.prompt} characters or fewer` });
  }

  const telegramToken = str(body, "telegramToken");
  for (const message of telegramTokenProblems(telegramToken)) {
    problems.push({ field: "telegramToken", message });
  }

  const providerKey = str(body, "providerKey");
  if (providerKey === "") problems.push({ field: "providerKey", message: "is required" });
  else if (providerKey.length > LIMITS.providerKey) {
    problems.push({ field: "providerKey", message: `must be ${LIMITS.providerKey} characters or fewer` });
  }

  // Only meaningful for a provider outside OpenClaw's built-in table, but not
  // rejected for a built-in one: a custom deployment of a known provider is a
  // real thing, and guessing otherwise would refuse a valid configuration.
  let providerMeta: { baseUrl?: string; api?: string } | undefined;
  if (isRecord(body.providerMeta)) {
    const baseUrl = str(body.providerMeta, "baseUrl");
    const api = str(body.providerMeta, "api");
    if (baseUrl.length > LIMITS.providerBaseUrl) {
      problems.push({ field: "providerMeta.baseUrl", message: "is too long" });
    }
    if (api.length > LIMITS.providerApi) {
      problems.push({ field: "providerMeta.api", message: "is too long" });
    }
    if (baseUrl !== "") {
      try {
        new URL(baseUrl);
      } catch {
        problems.push({ field: "providerMeta.baseUrl", message: "is not a URL" });
      }
    }
    providerMeta = {
      ...(baseUrl === "" ? {} : { baseUrl }),
      ...(api === "" ? {} : { api }),
    };
    if (Object.keys(providerMeta).length === 0) providerMeta = undefined;
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    capsuleName: `${label}.${parentName}`.toLowerCase(),
    request: {
      label,
      owner,
      context,
      telegramUrl,
      model,
      runtime,
      prompt,
      telegramToken,
      providerKey,
      providerMeta,
    },
  };
}

/** The provider half of `agent-model`, which is where the key gets filed. */
export function providerOf(request: PrepareRequest): string {
  return parseModelRef(request.model)!.provider;
}

////////////////////////////////////////////////////////////////////////////
// Rate limits
////////////////////////////////////////////////////////////////////////////

/**
 * How much a single caller may prepare.
 *
 * These are counted in Postgres, not in memory — see db/migrations/003. The
 * numbers are set so a person configuring a fleet of five agents, making
 * mistakes, never sees them.
 *
 * **There is deliberately no per-label limit.** It is the obvious third rule and
 * it would reintroduce exactly the hole this endpoint was redesigned to close:
 * anyone could burn a label's quota and lock everyone else out of a name that is
 * still free on chain. A limit that can be spent by an attacker on someone
 * else's behalf is not a limit, it is a weapon.
 */
export const RATE_LIMITS = {
  windowSeconds: 3600,
  /** Per signing address. Cheap to evade — addresses are free — but it makes
   *  the cost of evasion visible, and it is the key the writes are filed under. */
  perOwner: 12,
  /** Per client, keyed by an HMAC of the IP. This is the one that actually bites. */
  perClient: 30,
  /** Across everyone. A blunt backstop so a distributed flood still has a
   *  ceiling, set well above any plausible real minute at a hackathon. */
  perGlobal: 400,
} as const;
