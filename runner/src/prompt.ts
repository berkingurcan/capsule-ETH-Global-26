/**
 * Turning the pointer on the name into the instructions off it.
 *
 * `agent-prompt` is "cap_8f3d1a" — a claim check. The body it stands for lives
 * off chain, and this is the cloakroom.
 *
 * The interesting part is how the service decides whether to hand it over. The
 * obvious answer is an API key per agent, which means the provisioner generates
 * a secret, stores it, injects it, and now there is a second credential system
 * next to a protocol that already has one. Instead: the runner signs, the
 * service recovers the signer, and resolves the name's `addr` record to check
 * it. Nothing is ever distributed. The credential already existed and was
 * already published.
 */
import { isAddressEqual, type Address } from "viem";
import { Secret } from "./secret.js";

/** Domain separator. A signature for one purpose must not work for another. */
export const PROMPT_FETCH_PREFIX = "capsule-prompt-fetch";

/** Requests older than this are refused, so a captured one does not last. */
export const SIGNATURE_TTL_SECONDS = 60;

/**
 * The wire contract, defined once and imported by both sides. The real service
 * in build step 4 implements this; the dev server under dev/ is disposable.
 */
export function promptFetchMessage(name: string, promptRef: string, timestamp: number): string {
  return [PROMPT_FETCH_PREFIX, name, promptRef, String(timestamp)].join("\n");
}

export type PromptFailure = "unauthorized" | "not-found" | "transport" | "server";

export class PromptError extends Error {
  readonly kind: PromptFailure;
  readonly status: number | undefined;
  constructor(kind: PromptFailure, message: string, status?: number) {
    super(message);
    this.name = "PromptError";
    this.kind = kind;
    this.status = status;
  }
}

/** Only the parts of a viem account this needs. Keeps the module testable. */
export type Signer = {
  address: Address;
  signMessage: (args: { message: string }) => Promise<`0x${string}`>;
};

export type FetchPromptArgs = {
  /** Base URL — from `agent-endpoint[capsule]`, or the announced dev override. */
  endpoint: string;
  name: string;
  promptRef: string;
  signer: Signer;
  timeoutMs?: number;
};

export async function fetchPrompt(args: FetchPromptArgs): Promise<Secret<string>> {
  const { endpoint, name, promptRef, signer, timeoutMs = 10_000 } = args;

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signer.signMessage({
    message: promptFetchMessage(name, promptRef, timestamp),
  });

  const url = `${endpoint.replace(/\/+$/, "")}/prompt/${encodeURIComponent(promptRef)}`;

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
    throw new PromptError(
      "transport",
      `could not reach the prompt service: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new PromptError("unauthorized", "the prompt service refused this signature", response.status);
  }
  if (response.status === 404) {
    throw new PromptError("not-found", `no prompt stored for ${promptRef}`, response.status);
  }
  if (!response.ok) {
    throw new PromptError("server", `prompt service returned ${response.status}`, response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PromptError("server", "prompt service returned a body that is not JSON");
  }

  const prompt = (body as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) {
    // Deliberately does not quote the body: whatever came back may be the
    // prompt in a shape we did not expect, and an error message is a log line.
    throw new PromptError("server", "prompt service returned no prompt field");
  }

  return new Secret(prompt);
}

/**
 * Keyed on the pointer and nothing else.
 *
 * The loop re-reads the name every tick. When `agent-prompt` still says
 * cap_8f3d1a there is nothing to fetch; when the owner changes it on chain the
 * next tick fetches a different body and the agent becomes a different agent
 * without a redeploy. That is the whole "change the record, change the agent"
 * demo, and it lives in this one comparison.
 */
export class PromptCache {
  #ref: string | undefined;
  #body: Secret<string> | undefined;

  get ref(): string | undefined {
    return this.#ref;
  }

  /** True when this fetch replaced the previous prompt. */
  async load(args: FetchPromptArgs): Promise<{ body: Secret<string>; changed: boolean }> {
    if (this.#ref === args.promptRef && this.#body !== undefined) {
      return { body: this.#body, changed: false };
    }
    const body = await fetchPrompt(args);
    this.#ref = args.promptRef;
    this.#body = body;
    return { body, changed: true };
  }

  /** The last prompt that loaded cleanly. Mid-loop failures fall back to it. */
  get lastGood(): Secret<string> | undefined {
    return this.#body;
  }
}

/** Shared by the service side: is this signature still inside the window? */
export function isTimestampFresh(timestamp: number, now = Math.floor(Date.now() / 1000)): boolean {
  const age = now - timestamp;
  // Reject the future too, with a little slack for clock skew between hosts.
  return age <= SIGNATURE_TTL_SECONDS && age >= -5;
}

export function isSameAddress(a: Address, b: Address): boolean {
  return isAddressEqual(a, b);
}
