/**
 * The credentials the runtime needs, fetched the same way the prompt is.
 *
 * OpenClaw needs two secrets the chain must never carry: the owner's Telegram bot token
 * and a model provider API key. Both are the owner's property, both are sealed in the
 * Capsule store at launch, and both come down over the request the runner is already
 * entitled to make — it signs with its agent key, the service recovers the signer and
 * checks it against the name's `addr` record.
 *
 * That is the same argument as the prompt fetch, and it is worth restating because it is
 * the reason there is no credential pipeline here: nothing is issued to the agent. The
 * key it signs with is the key ENS already published as its identity. Revoke the `addr`
 * record and the agent cannot fetch its own bot token, with nothing deployed to make that
 * true.
 *
 * A DIFFERENT domain separator from the prompt fetch, deliberately. A signature captured
 * from a prompt request must not be replayable against the endpoint that hands out
 * credentials — same key, same TTL, different purpose, different message.
 */
import { Secret } from "./secret.js";

/** Domain separator. Must match web/lib/capsule/wire.ts. */
export const RUNTIME_FETCH_PREFIX = "capsule-runtime-fetch";

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

export type RuntimeCredentials = {
  /** The owner's own Telegram bot. Never on chain — only the public `t.me` URL is. */
  telegramBotToken: Secret<string>;
  /** e.g. "anthropic". Decides which environment variable the gateway is given. */
  modelProvider: string;
  modelApiKey: Secret<string>;
  /**
   * Numeric Telegram user ids allowed to DM the bot. Empty means the owner has not
   * restricted it, and the supervisor then refuses to open the channel — see openclaw.ts.
   */
  allowFrom: string[];
};

export type Signer = {
  address: `0x${string}`;
  signMessage: (args: { message: string }) => Promise<`0x${string}`>;
};

export async function fetchRuntimeCredentials(args: {
  endpoint: string;
  name: string;
  signer: Signer;
  timeoutMs?: number;
}): Promise<RuntimeCredentials> {
  const { endpoint, name, signer, timeoutMs = 10_000 } = args;

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signer.signMessage({ message: runtimeFetchMessage(name, timestamp) });

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
    throw new RuntimeError(
      "transport",
      `could not reach the capsule service: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new RuntimeError("unauthorized", "the capsule service refused this signature", response.status);
  }
  if (response.status === 404) {
    throw new RuntimeError("not-found", `no runtime credentials stored for ${name}`, response.status);
  }
  if (!response.ok) {
    throw new RuntimeError("server", `capsule service returned ${response.status}`, response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RuntimeError("server", "capsule service returned a body that is not JSON");
  }

  const raw = body as Partial<Record<keyof RuntimeCredentials | "allowFrom", unknown>> | null;

  const telegram = raw?.telegramBotToken;
  const provider = raw?.modelProvider;
  const apiKey = raw?.modelApiKey;

  // Checked field by field, and the error never quotes the body. Whatever came back may
  // BE the credentials in a shape we did not expect, and an error message is a log line.
  if (typeof telegram !== "string" || telegram.length === 0) {
    throw new RuntimeError("server", "no telegramBotToken in the runtime response");
  }
  if (typeof provider !== "string" || provider.length === 0) {
    throw new RuntimeError("server", "no modelProvider in the runtime response");
  }
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new RuntimeError("server", "no modelApiKey in the runtime response");
  }

  const allowFrom = Array.isArray(raw?.allowFrom)
    ? raw.allowFrom.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];

  return {
    telegramBotToken: new Secret(telegram),
    modelProvider: provider,
    modelApiKey: new Secret(apiKey),
    allowFrom,
  };
}
