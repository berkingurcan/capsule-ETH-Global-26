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
 * The credential fetch. CANONICAL SOURCE: runner/src/runtime.ts
 *
 * A separate domain separator, not a second parameter on the first one: a
 * signature captured for the prompt path must not open the credential path.
 * The prompt is the agent's instructions and is bad to leak; the provider key is
 * the owner's money and is worse.
 *
 * The message names no resource. The prompt fetch quotes a ref the caller read
 * off the chain; this one asks only "as this name, at this moment", and the
 * service reads `agent-model` itself to decide what that entitles the caller to.
 */
export const RUNTIME_FETCH_PREFIX = "capsule-runtime-fetch";

export function runtimeFetchMessage(name: string, timestamp: number): string {
  return [RUNTIME_FETCH_PREFIX, name, String(timestamp)].join("\n");
}

/**
 * The launchpad → control plane request, signed by the owner's wallet.
 *
 * A third separator, for a caller that is not an agent. The other two are signed
 * by a key this system generated and handed to a container; this one is signed
 * in a browser by a person, and it authorises a *write* rather than a read. A
 * signature captured from any of the three must be useless on the other two.
 *
 * ## Why the body is in the message
 *
 * The other two messages name a resource and nothing else, because the answer is
 * whatever the chain currently says. This one carries content — a prompt body, a
 * bot token, a provider key — and the signature has to cover it, or it
 * authorises "this address wanted to prepare something" rather than "this
 * address wanted to prepare *this*". Anything that can reach between the browser
 * and the route within the TTL could otherwise keep the header and swap the
 * payload.
 *
 * `digest` is the keccak256 of the exact request body, computed over the bytes
 * that are actually sent. Not over a re-serialisation of a parsed object: two
 * JSON encoders disagree about key order and unicode escapes, and a digest that
 * is right on one platform and wrong on another is worse than no digest.
 *
 * ## What this does NOT establish
 *
 * That the signer owns, or will own, the name. Nobody does yet — `mint()` is
 * permissionless and the name is unregistered at this point. It binds the write
 * to an address so a rate limit has something to count, and binds the content to
 * that address so it cannot be tampered with. Ownership is settled later, on
 * chain, by whoever actually sends the mint.
 */
export const PREPARE_PREFIX = "capsule-prepare";

export function prepareMessage(
  capsuleName: string,
  owner: string,
  digest: string,
  timestamp: number,
): string {
  return [PREPARE_PREFIX, capsuleName, owner.toLowerCase(), digest, String(timestamp)].join("\n");
}

/**
 * Longer than the agents' 60 seconds, because a person is in the loop.
 *
 * The runner signs and sends in the same tick; a human sees a wallet popup,
 * reads it, and may pick up their phone to approve it. Sixty seconds fails that
 * often enough to train people to click without reading, which costs more than
 * the extra window.
 */
export const PREPARE_TTL_SECONDS = 300;

export function isPrepareTimestampFresh(
  timestamp: number,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const age = now - timestamp;
  return age <= PREPARE_TTL_SECONDS && age >= -CLOCK_SKEW_SECONDS;
}

export function isTimestampFresh(timestamp: number, now = Math.floor(Date.now() / 1000)): boolean {
  const age = now - timestamp;
  return age <= SIGNATURE_TTL_SECONDS && age >= -CLOCK_SKEW_SECONDS;
}

export function isSameAddress(a: Address, b: Address): boolean {
  return isAddressEqual(a, b);
}
