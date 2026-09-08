/**
 * GET /api/runtime — the credentials the gateway needs, to the agent that owns them.
 *
 * The prompt route hands back what an agent should say. This hands back what it needs in
 * order to say it anywhere: the owner's Telegram bot token and a model provider API key.
 * Neither can live on chain — an ENS text record is published to everyone, permanently,
 * and a leaked bot token needs a revocation a record cannot give.
 *
 * The authorisation is identical to the prompt route's, deliberately, because it is the
 * argument this project is making: there are no API keys in this system. Nothing is
 * issued to an agent. The runner signs a short-lived message with the key it already
 * holds, this route recovers the signer, and ENS decides whether the name claims that
 * address. Change the `addr` record and the agent stops being able to fetch its own bot
 * token, with nothing deployed here to make that true.
 *
 * Two things differ from the prompt route, and both are on purpose:
 *
 *   Different domain separator. Same key, same 60-second window, different purpose — a
 *   signature captured from a prompt request must not open the credential endpoint.
 *
 *   Scoped by name, not by a public ref. There is no pointer for credentials and there
 *   must not be one: a pointer would be a public handle on a secret, and the mistake we
 *   avoided with prompts (a ref-only lookup letting any agent read any other agent's) is
 *   not one to reintroduce for the values that actually are bearer tokens.
 */
import { NextResponse } from "next/server";
import { recoverMessageAddress, type Hex } from "viem";
import { createServerClient } from "@/lib/capsule/chain";
import { loadServerEnv } from "@/lib/capsule/env";
import { readAddr } from "@/lib/capsule/resolve";
import { createStore, readRuntimeBundle } from "@/lib/capsule/store";
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
 * One shape for every refusal. `reason` is what the caller sees and is intentionally
 * vague; `log` is what we see. This route's 404 in particular must not distinguish "no
 * such capsule" from "that capsule has no credentials", or it becomes a fleet enumerator.
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

  // --- 4. does the name claim this signer? ---------------------------------
  let claimed;
  try {
    claimed = (await readAddr(createServerClient(env.rpcUrl), name)).address;
  } catch (error) {
    // We could not perform the check, which is not the same as failing it. 502 rather
    // than 403 so an RPC outage does not look to the runner like a revoked permission.
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.error(`runtime 502 — could not resolve ${name}: ${detail}`);
    return NextResponse.json(
      { error: "could not resolve the name" },
      { status: 502, headers: NO_STORE },
    );
  }

  if (!isSameAddress(signer, claimed)) {
    return deny(403, "the name does not claim this signer", `${name}: ${signer} != addr ${claimed}`);
  }

  // --- 5. the bundle -------------------------------------------------------
  let bundle;
  try {
    bundle = await readRuntimeBundle(createStore(env), { capsuleName: name });
  } catch (error) {
    // A row that will not decrypt is an integrity failure, not a miss.
    console.error(`runtime 500 — ${name}: ${error instanceof Error ? error.name : "?"}`);
    return NextResponse.json({ error: "internal error" }, { status: 500, headers: NO_STORE });
  }

  if (bundle === null) {
    return deny(404, "no runtime credentials for this capsule", `${name}: incomplete or absent`);
  }

  // Logged by shape only. This response body is the one place in the system where two
  // bearer tokens travel together, and stdout is a log stream somebody renders.
  console.log(
    `runtime 200 — ${name} (${bundle.modelProvider}, ${bundle.telegramAllowFrom.length} allowed dm ids)`,
  );

  return NextResponse.json(
    {
      telegramBotToken: bundle.telegramBotToken,
      modelProvider: bundle.modelProvider,
      modelApiKey: bundle.modelApiKey,
      allowFrom: bundle.telegramAllowFrom,
    },
    { status: 200, headers: NO_STORE },
  );
}
