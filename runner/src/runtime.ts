/**
 * The credentials the gateway needs, fetched the same way the prompt is.
 *
 * `agent-prompt` says what the agent thinks; `agent-model` says what does the
 * thinking. The first needs a body fetched from off chain, and so does the
 * second — a model reference is public, an API key is not.
 *
 * There is still nothing issued to an agent. The runner signs a short-lived
 * message with the key it already holds, the service recovers the signer and
 * asks ENS whether the name claims that address. Same credential, same absence
 * of a second identity system, one more thing it unlocks.
 *
 * The one interesting difference from the prompt path: **this request names
 * nothing.** The prompt fetch quotes a ref off the chain and asks for that ref;
 * this asks "give me what I need in order to be what my name says I am", and the
 * service reads `agent-model` itself to decide what that is. A runner cannot ask
 * for a provider key its own record does not currently reference — so a
 * compromised container leaks the key it was already using, and not the rest of
 * the owner's wallet of them.
 */
import { Secret } from "./secret.js";
import { SIGNATURE_TTL_SECONDS, type Signer } from "./prompt.js";
import { envVarFor } from "./providers.js";

/** Domain separator. A signature for one purpose must not work for another. */
export const RUNTIME_FETCH_PREFIX = "capsule-runtime-fetch";

// The replay window is the prompt path's, imported rather than restated: two
// TTLs that can drift apart is one more thing to keep in agreement for no gain.
export { SIGNATURE_TTL_SECONDS };

/** The wire contract, defined once and imported by both sides. */
export function runtimeFetchMessage(name: string, timestamp: number): string {
  return [RUNTIME_FETCH_PREFIX, name, String(timestamp)].join("\n");
}

export type RuntimeFailure = "unauthorized" | "not-found" | "transport" | "server";

export class RuntimeError extends Error {
  readonly kind: RuntimeFailure;
  readonly status: number | undefined;
  constructor(kind: RuntimeFailure, message: string, status?: number) {
    super(message);
    this.name = "RuntimeError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * One provider's credential.
 *
 * `baseUrl` and `api` are present only for a provider outside OpenClaw's
 * built-in table — they are how a custom or proxied endpoint is reached, they
 * are deployment detail rather than identity, and so they travel with the
 * credential instead of being written on chain. A built-in provider needs
 * neither: naming it in the model reference is enough.
 */
export type ProviderCredential = {
  provider: string;
  apiKey: Secret<string>;
  baseUrl: string | undefined;
  api: string | undefined;
};

export type RuntimeCredentials = {
  /**
   * The model reference the *service* resolved when it decided what to send.
   *
   * Echoed back so the runner can notice that the record changed between its own
   * read and the service's. That race is not an error — the next tick fixes it —
   * but silently configuring a gateway with a key for one provider and a model
   * reference for another produces an authentication failure whose cause is two
   * requests back.
   */
  model: string;
  providers: Map<string, ProviderCredential>;
  /** The owner's bot token, when they gave one. Absent is not an error here. */
  telegramToken: Secret<string> | undefined;
};

export type FetchRuntimeArgs = {
  /** Base URL — from `agent-endpoint[capsule]`, or the announced dev override. */
  endpoint: string;
  name: string;
  signer: Signer;
  timeoutMs?: number;
};

export async function fetchRuntime(args: FetchRuntimeArgs): Promise<RuntimeCredentials> {
  const { endpoint, name, signer, timeoutMs = 10_000 } = args;

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signer.signMessage({
    message: runtimeFetchMessage(name, timestamp),
  });

  const url = `${endpoint.replace(/\/+$/, "")}/runtime`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "x-capsule-name": name,
        "x-capsule-timestamp": String(timestamp),
        "x-capsule-signature": signature,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Network-shaped. Transient mid-loop, fatal at boot — never the revoke.
    throw new RuntimeError(
      "transport",
      `could not reach the runtime service: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new RuntimeError("unauthorized", "the runtime service refused this signature", response.status);
  }
  if (response.status === 404) {
    throw new RuntimeError("not-found", `no credentials stored for ${name}`, response.status);
  }
  if (!response.ok) {
    throw new RuntimeError("server", `runtime service returned ${response.status}`, response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RuntimeError("server", "runtime service returned a body that is not JSON");
  }

  return parseRuntimeBody(body);
}

/**
 * Separate from the fetch so it can be exercised without a server, and so the
 * shape assertions live in one place rather than scattered through the caller.
 *
 * Deliberately quotes nothing it rejects. Everything in this payload is a
 * secret, and an error message is a log line.
 */
export function parseRuntimeBody(body: unknown): RuntimeCredentials {
  const root = body as {
    model?: unknown;
    providers?: unknown;
    telegram?: { token?: unknown } | null;
  } | null;

  if (root === null || typeof root !== "object") {
    throw new RuntimeError("server", "runtime service returned no object");
  }

  const model = typeof root.model === "string" ? root.model : "";

  const providers = new Map<string, ProviderCredential>();
  const rawProviders = root.providers;
  if (rawProviders !== null && typeof rawProviders === "object") {
    for (const [provider, value] of Object.entries(rawProviders as Record<string, unknown>)) {
      const entry = value as { apiKey?: unknown; baseUrl?: unknown; api?: unknown } | null;
      if (entry === null || typeof entry !== "object") continue;
      if (typeof entry.apiKey !== "string" || entry.apiKey === "") continue;

      providers.set(provider, {
        provider,
        apiKey: new Secret(entry.apiKey),
        baseUrl: typeof entry.baseUrl === "string" && entry.baseUrl !== "" ? entry.baseUrl : undefined,
        api: typeof entry.api === "string" && entry.api !== "" ? entry.api : undefined,
      });
    }
  }

  const rawToken = root.telegram?.token;
  const telegramToken =
    typeof rawToken === "string" && rawToken !== "" ? new Secret(rawToken) : undefined;

  return { model, providers, telegramToken };
}

/**
 * What is safe to say about a credential set in a log line.
 *
 * The provider ids and the variable names are public — they are derived from a
 * record anyone can resolve. The keys are not, and never appear here.
 */
export function describeCredentials(credentials: RuntimeCredentials): string {
  if (credentials.providers.size === 0) return "no provider keys";
  return [...credentials.providers.keys()]
    .sort()
    .map((provider) => `${provider} (${envVarFor(provider)})`)
    .join(", ");
}
