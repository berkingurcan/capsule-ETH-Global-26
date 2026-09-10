/**
 * The browser half of POST /api/capsule/prepare.
 *
 * Client-safe: no env, no node:crypto, no chain client. It exists so that the
 * exact bytes the route verifies are produced in exactly one place. The digest
 * has to cover the body as sent, and "as sent" is decided by whoever calls
 * `JSON.stringify` — so if the caller serialised the body and this module
 * serialised it again, the two could differ over key order or unicode escaping
 * and every request would fail its digest check for reasons invisible in both
 * files.
 *
 * `scripts/check-prepare.ts` signs with this module too. A check that rolled
 * its own signing would prove the check works, not that the launchpad will.
 */
import { keccak256, toHex, type Address } from "viem";
import { HEADER_SIGNATURE, HEADER_TIMESTAMP, prepareMessage } from "./wire";

/** Mirrors the route. Exported so the launch form can name it in an error. */
export const HEADER_DIGEST = "x-capsule-digest";

export type PrepareInput = {
  label: string;
  owner: Address;
  context: string;
  telegramUrl: string;
  model: string;
  prompt: string;
  telegramToken: string;
  providerKey: string;
  providerMeta?: { baseUrl?: string; api?: string };
};

/** What the mint needs. Every field comes back from the server, not the form. */
export type PrepareResult = {
  capsuleName: string;
  label: string;
  owner: Address;
  agent: Address;
  promptRef: string;
  config: {
    context: string;
    telegramUrl: string;
    capsuleEndpoint: string;
    model: string;
    runtime: string;
    promptPointer: string;
  };
};

export type PrepareFailure = {
  status: number;
  error: string;
  problems?: { field: string; message: string }[];
  retryAfterSeconds?: number;
};

export class PrepareError extends Error {
  readonly failure: PrepareFailure;
  constructor(failure: PrepareFailure) {
    super(failure.error);
    this.name = "PrepareError";
    this.failure = failure;
  }
}

/** Signs a message with the owner's wallet. Matches viem's `signMessage`. */
export type SignMessage = (args: { message: string }) => Promise<string>;

export async function prepareCapsuleRequest(
  input: PrepareInput,
  signMessage: SignMessage,
  options: { baseUrl?: string; capsuleName?: string; parentName?: string } = {},
): Promise<PrepareResult> {
  const label = input.label.trim().toLowerCase();

  // The route rebuilds this from its own CAPSULE_PARENT_NAME, and the signature
  // covers it — so a browser holding a stale parent name gets a clean signature
  // failure rather than a capsule prepared under the wrong parent.
  const capsuleName =
    options.capsuleName ??
    (options.parentName === undefined ? "" : `${label}.${options.parentName}`.toLowerCase());
  if (capsuleName === "") {
    throw new Error("prepareCapsuleRequest needs either capsuleName or parentName");
  }

  const payload = {
    label,
    // Echoed so the route builds the same capsule name this signature covers.
    // Omitted when the caller only gave a full name, which is the shape
    // `scripts/check-prepare.ts` uses against the deployment's own default.
    ...(options.parentName === undefined ? {} : { parent: options.parentName.toLowerCase() }),
    owner: input.owner,
    context: input.context,
    telegramUrl: input.telegramUrl,
    model: input.model,
    runtime: "openclaw",
    prompt: input.prompt,
    telegramToken: input.telegramToken,
    providerKey: input.providerKey,
    ...(input.providerMeta === undefined ? {} : { providerMeta: input.providerMeta }),
  };

  // Serialised once. This string is what is hashed and what is sent.
  const raw = JSON.stringify(payload);
  const digest = keccak256(toHex(raw));
  const timestamp = Math.floor(Date.now() / 1000);

  const signature = await signMessage({
    message: prepareMessage(capsuleName, input.owner, digest, timestamp),
  });

  const response = await fetch(`${options.baseUrl ?? ""}/api/capsule/prepare`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HEADER_TIMESTAMP]: String(timestamp),
      [HEADER_SIGNATURE]: signature,
      [HEADER_DIGEST]: digest,
    },
    body: raw,
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    throw new PrepareError({
      status: response.status,
      error: typeof body.error === "string" ? body.error : `prepare failed (${response.status})`,
      problems: Array.isArray(body.problems)
        ? (body.problems as { field: string; message: string }[])
        : undefined,
      retryAfterSeconds: typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : undefined,
    });
  }

  return body as unknown as PrepareResult;
}
