/**
 * The prompt-fetch wire contract, server side.
 *
 * CANONICAL SOURCE: runner/src/prompt.ts
 *
 * This is a deliberate copy, not an import. The runner ships as a standalone
 * container whose Dockerfile installs only runner/package.json, so making it
 * depend on a shared workspace package would break an image that already
 * works. The cost of copying is drift, and drift here is silent: change the
 * separator or the TTL on one side and every agent gets a 403 that looks like
 * a revoked permission.
 *
 * So the copy is guarded. `npm run check:wire` re-derives these literals from
 * the runner source and fails if they have moved apart. Run it in CI.
 */
import { isAddressEqual, type Address } from "viem";

/** Domain separator. A signature for one purpose must not work for another. */
export const PROMPT_FETCH_PREFIX = "capsule-prompt-fetch";

/** Requests older than this are refused, so a captured one does not last. */
export const SIGNATURE_TTL_SECONDS = 60;

/** Clock skew allowance for timestamps that appear to be in the future. */
export const CLOCK_SKEW_SECONDS = 5;

export const HEADER_NAME = "x-capsule-name";
export const HEADER_TIMESTAMP = "x-capsule-timestamp";
export const HEADER_SIGNATURE = "x-capsule-signature";

export function promptFetchMessage(name: string, promptRef: string, timestamp: number): string {
  return [PROMPT_FETCH_PREFIX, name, promptRef, String(timestamp)].join("\n");
}

/**
 * Domain separator for the runtime credential fetch. CANONICAL: runner/src/runtime.ts.
 *
 * Deliberately not the prompt prefix. Both requests are signed by the same key inside the
 * same 60-second window, and the credential endpoint hands back the owner's Telegram bot
 * token — a signature captured from a prompt request must not open it. Separate prefix,
 * separate message shape, and no ref: credentials are per capsule, not per pointer.
 */
export const RUNTIME_FETCH_PREFIX = "capsule-runtime-fetch";

export function runtimeFetchMessage(name: string, timestamp: number): string {
  return [RUNTIME_FETCH_PREFIX, name, String(timestamp)].join("\n");
}

export function isTimestampFresh(timestamp: number, now = Math.floor(Date.now() / 1000)): boolean {
  const age = now - timestamp;
  return age <= SIGNATURE_TTL_SECONDS && age >= -CLOCK_SKEW_SECONDS;
}

export function isSameAddress(a: Address, b: Address): boolean {
  return isAddressEqual(a, b);
}
