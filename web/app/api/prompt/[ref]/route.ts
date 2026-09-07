/**
 * GET /api/prompt/:ref — the cloakroom.
 *
 * `agent.prompt` on chain is a claim check like "cap_8f3d1a". This hands back
 * what it stands for, to the one caller entitled to it.
 *
 * There are no API keys in this system. The provisioner never issues a
 * credential to an agent, because issuing one would mean generating a secret,
 * storing it, injecting it, and maintaining a second identity system beside a
 * protocol that already has one. Instead the runner signs a short-lived
 * message with the key it already holds, and this route recovers the signer
 * and asks ENS whether the name claims that address.
 *
 * The authorisation database is the chain. Revoke the agent's `addr` record
 * and it stops being able to read its own prompt, with nothing deployed here.
 *
 * Order of checks is deliberate — cheap and local first, network last:
 *
 *   1. headers present            free
 *   2. timestamp inside the TTL   free, kills replayed captures early
 *   3. signature recovers         local ecrecover, no network
 *   4. name's addr matches        one RPC call
 *   5. row exists for (ref, name) one query
 *
 * An unauthenticated flood therefore costs us nothing but CPU until step 4.
 */
import { NextResponse } from "next/server";
import { recoverMessageAddress, type Hex } from "viem";
import { createServerClient } from "@/lib/capsule/chain";
import { loadServerEnv } from "@/lib/capsule/env";
import { readAddr } from "@/lib/capsule/resolve";
import { createStore, readPrompt } from "@/lib/capsule/store";
import {
  HEADER_NAME,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  isSameAddress,
  isTimestampFresh,
  promptFetchMessage,
} from "@/lib/capsule/wire";

/** node:crypto and the AES envelope. Not edge-compatible, and not trying to be. */
export const runtime = "nodejs";
/** Every response depends on headers and on chain state. Never cache one. */
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store, no-cache, must-revalidate" };

/**
 * One shape for every refusal.
 *
 * `reason` is what the caller sees and is intentionally vague; `log` is what we
 * see. Telling a caller which of the five checks failed tells an attacker which
 * half of their guess was right — and worse, distinguishing "no such ref" from
 * "not your ref" would turn this endpoint into a way to enumerate the fleet.
 */
function deny(status: number, reason: string, log: string): NextResponse {
  console.warn(`prompt deny ${status} — ${log}`);
  return NextResponse.json({ error: reason }, { status, headers: NO_STORE });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ ref: string }> },
): Promise<NextResponse> {
  const { ref } = await context.params;

  const name = request.headers.get(HEADER_NAME);
  const timestampHeader = request.headers.get(HEADER_TIMESTAMP);
  const signature = request.headers.get(HEADER_SIGNATURE);

  // --- 1. shape ------------------------------------------------------------
  if (name === null || timestampHeader === null || signature === null) {
    return deny(400, "missing capsule headers", `${ref}: missing headers`);
  }

  // --- 2. freshness --------------------------------------------------------
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || !isTimestampFresh(timestamp)) {
    // A captured request must not work forever. 60 seconds is enough for a
    // slow boot and short enough that a leaked log line is not a key.
    return deny(403, "signature expired", `${ref}: stale timestamp ${timestampHeader}`);
  }

  // --- 3. recovery ---------------------------------------------------------
  let signer;
  try {
    signer = await recoverMessageAddress({
      message: promptFetchMessage(name, ref, timestamp),
      signature: signature as Hex,
    });
  } catch {
    return deny(403, "bad signature", `${ref}: signature did not recover`);
  }

  const env = loadServerEnv();

  // --- 4. does the name claim this signer? ---------------------------------
  let claimed;
  try {
    claimed = (await readAddr(createServerClient(env.rpcUrl), name)).address;
  } catch (error) {
    // We could not perform the check, which is not the same as failing it.
    // 502 rather than 403 so an RPC outage does not look to the runner like a
    // revoked permission — the one misdiagnosis this system must never make.
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.error(`prompt 502 — could not resolve ${name}: ${detail}`);
    return NextResponse.json(
      { error: "could not resolve the name" },
      { status: 502, headers: NO_STORE },
    );
  }

  if (!isSameAddress(signer, claimed)) {
    return deny(403, "the name does not claim this signer", `${ref}: ${signer} != addr ${claimed}`);
  }

  // --- 5. the row, scoped to the caller ------------------------------------
  // Scoped by (ref, capsule_name), not by ref alone. Refs are published in a
  // public text record, so a ref-only lookup would let any authenticated agent
  // read any other agent's prompt by quoting a value it read off the chain.
  let prompt;
  try {
    prompt = await readPrompt(createStore(env), { ref, capsuleName: name });
  } catch (error) {
    // A row that will not decrypt is an integrity failure, not a miss. Loud in
    // our logs, indistinguishable from a miss to the caller.
    console.error(`prompt 500 — ${ref} for ${name}: ${error instanceof Error ? error.name : "?"}`);
    return NextResponse.json({ error: "internal error" }, { status: 500, headers: NO_STORE });
  }

  if (prompt === null) {
    return deny(404, "no prompt stored for this pointer", `${ref}: no row for ${name}`);
  }

  console.log(`prompt 200 — ${ref} for ${name} (${prompt.body.length} chars)`);
  return NextResponse.json({ prompt: prompt.body }, { status: 200, headers: NO_STORE });
}
