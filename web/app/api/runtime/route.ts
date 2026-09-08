/**
 * GET /api/runtime — the credentials, scoped by the record.
 *
 * The prompt route hands back what a pointer stands for. This one hands back
 * what a name *needs*: the API key for whichever provider `agent-model`
 * currently references, and the owner's Telegram token.
 *
 * Same authorisation, one layer deeper. There are still no API keys issued to
 * agents: the runner signs with the key it already holds, this route recovers
 * the signer, and ENS says whether the name claims that address.
 *
 * ## The request names nothing
 *
 * That is the design, not an omission. `/api/prompt/:ref` takes a ref the caller
 * read off the chain; if this took a provider id, a runner could ask for any key
 * its owner had ever stored — including for models this name has never been
 * configured to run. Instead the route resolves `agent-model` itself and answers
 * only for the provider named there.
 *
 * So a compromised container leaks the key it was already spending, and not the
 * rest of the owner's wallet of them. The blast radius of a stolen agent key is
 * bounded by a record its owner controls and can change in one transaction.
 *
 * Order of checks is the prompt route's, for the same reasons — cheap and local
 * first, network last:
 *
 *   1. headers present            free
 *   2. timestamp inside the TTL   free, kills replayed captures early
 *   3. signature recovers         local ecrecover, no network
 *   4. addr + agent-model         one multicall, one instant
 *   5. the rows for that provider one query each
 */
import { NextResponse } from "next/server";
import { recoverMessageAddress, type Hex } from "viem";
import { createServerClient } from "@/lib/capsule/chain";
import { loadServerEnv } from "@/lib/capsule/env";
import { isBuiltInProvider, parseModelRef } from "@/lib/capsule/providers";
import { readIdentity } from "@/lib/capsule/resolve";
import { createStore, secrets } from "@/lib/capsule/store";
import {
  HEADER_NAME,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  isSameAddress,
  isTimestampFresh,
  runtimeFetchMessage,
} from "@/lib/capsule/wire";

/** node:crypto and the AES envelope. Not edge-compatible, and not trying to be. */
export const runtime = "nodejs";
/** Every response depends on headers and on chain state. Never cache one. */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store, no-cache, must-revalidate" };

/**
 * One shape for every refusal. `reason` is what the caller sees and is vague on
 * purpose; `log` is what we see.
 */
function deny(status: number, reason: string, log: string): NextResponse {
  console.warn(`runtime deny ${status} — ${log}`);
  return NextResponse.json({ error: reason }, { status, headers: NO_STORE });
}

export async function GET(request: Request): Promise<NextResponse> {
  const name = request.headers.get(HEADER_NAME);
  const timestampHeader = request.headers.get(HEADER_TIMESTAMP);
  const signature = request.headers.get(HEADER_SIGNATURE);

  // --- 1. shape ------------------------------------------------------------
  if (name === null || timestampHeader === null || signature === null) {
    return deny(400, "missing capsule headers", "missing headers");
  }

  // --- 2. freshness --------------------------------------------------------
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || !isTimestampFresh(timestamp)) {
    return deny(403, "signature expired", `${name}: stale timestamp ${timestampHeader}`);
  }

  // --- 3. recovery ---------------------------------------------------------
  let signer;
  try {
    signer = await recoverMessageAddress({
      message: runtimeFetchMessage(name, timestamp),
      signature: signature as Hex,
    });
  } catch {
    return deny(403, "bad signature", `${name}: signature did not recover`);
  }

  const env = loadServerEnv();

  // --- 4. who the name claims, and what it says it runs ---------------------
  // Both in one multicall, so they describe the same instant. Two reads could
  // straddle a setText and answer for two different configurations of the same
  // name — which would mean handing a runner a key for a model its record no
  // longer names.
  let identity;
  try {
    identity = await readIdentity(createServerClient(env.rpcUrl), name);
  } catch (error) {
    // We could not perform the check, which is not the same as failing it. 502
    // rather than 403 so an RPC outage does not look to the runner like a
    // revoked permission — the one misdiagnosis this system must never make.
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.error(`runtime 502 — could not resolve ${name}: ${detail}`);
    return NextResponse.json(
      { error: "could not resolve the name" },
      { status: 502, headers: NO_STORE },
    );
  }

  if (!isSameAddress(signer, identity.address)) {
    return deny(403, "the name does not claim this signer", `${name}: ${signer} != addr ${identity.address}`);
  }

  const parsed = parseModelRef(identity.model);
  if (parsed === null) {
    // The record is unreadable, not the caller unauthorised. 404 rather than 403
    // so the runner treats it as "nothing stored for me" and keeps its last good
    // configuration, instead of reading a malformed record as a lost permission.
    return deny(404, "no usable agent-model on this name", `${name}: agent-model is not <provider>/<model>`);
  }

  // --- 5. the rows ---------------------------------------------------------
  const store = createStore(env);

  let providerRow;
  let telegramRow;
  try {
    [providerRow, telegramRow] = await Promise.all([
      secrets.readProviderKey(store, { capsuleName: name, provider: parsed.provider }),
      secrets.readTelegramToken(store, { capsuleName: name }),
    ]);
  } catch (error) {
    // A row that will not decrypt is an integrity failure, not a miss. Loud in
    // our logs, indistinguishable from a miss to the caller.
    console.error(`runtime 500 — ${name}: ${error instanceof Error ? error.name : "?"}`);
    return NextResponse.json({ error: "internal error" }, { status: 500, headers: NO_STORE });
  }

  // A missing provider key is a 200 with an empty set, not a 404.
  //
  // The runner has to be able to tell "your owner has not given you a Gemini key"
  // apart from "the control plane is down", because it survives the first and
  // must warn loudly about it while keeping the previous model running. Refusing
  // the whole request would collapse a configuration problem into a transport
  // one and cost the runner its last good credentials.
  const providers: Record<string, { apiKey: string; baseUrl?: string; api?: string }> = {};
  if (providerRow !== null) {
    providers[parsed.provider] = {
      apiKey: providerRow.value,
      ...(providerRow.meta.baseUrl !== undefined ? { baseUrl: providerRow.meta.baseUrl } : {}),
      ...(providerRow.meta.api !== undefined ? { api: providerRow.meta.api } : {}),
    };
  }

  console.log(
    `runtime 200 — ${name} · ${identity.model} · ${
      providerRow === null ? `no key stored for ${parsed.provider}` : `${parsed.provider} key`
    }${telegramRow === null ? "" : " + telegram"}${
      providerRow !== null && !isBuiltInProvider(parsed.provider) ? " (custom)" : ""
    }`,
  );

  return NextResponse.json(
    {
      // Echoed so the runner can notice the record changed between its read and
      // ours. Not an error — the next tick reconciles it — but configuring a
      // gateway with one provider's key and another's model reference fails as
      // an authentication error two requests from its cause.
      model: identity.model,
      providers,
      ...(telegramRow === null ? {} : { telegram: { token: telegramRow.value } }),
    },
    { status: 200, headers: NO_STORE },
  );
}
