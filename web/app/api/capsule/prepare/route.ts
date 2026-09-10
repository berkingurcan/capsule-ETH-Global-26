/**
 * POST /api/capsule/prepare — everything the mint needs, before the mint.
 *
 * `CapsuleMinter.mint()` takes an agent address and a prompt pointer as
 * arguments, so both have to exist before the transaction is signed. This route
 * generates the agent's keypair, seals the prompt and the credentials, and hands
 * back the two values the browser needs to build the mint.
 *
 * ## This is the one endpoint that writes for free
 *
 * Everywhere else in this system the chain authorises the request: an agent
 * signs, we recover the signer, and ENS says whether the name claims it. That
 * cannot work here, because the point of the call is that the name does not
 * exist yet. There is nothing on chain to ask.
 *
 * So the guard is four things, none of which is sufficient alone:
 *
 *   1. **A signature from the address that will own the name.** It does not
 *      prove ownership — nobody owns an unregistered name — but it binds the
 *      write to an address and covers the body, so the content cannot be
 *      swapped in flight and the rate limit has something to count.
 *   2. **Rate limits in Postgres**, per address, per client and globally.
 *      Addresses are free to generate, so the per-client limit is the one that
 *      bites; the global one is the backstop for a distributed flood.
 *   3. **Validation with size caps**, so a request that gets through cannot
 *      store an unbounded number of bytes.
 *   4. **A chain read**, last and only if everything else passed: if the label
 *      is already registered the mint would revert, so there is no reason to
 *      store anything for it.
 *
 * ## What it deliberately does not do
 *
 * It does not reserve the name. Several people may prepare the same label and
 * all of them get rows; the mint decides which one is real, and every read
 * afterwards is scoped to the agent address the chain publishes as `addr`.
 * Refusing a second prepare would be a denial the chain itself does not impose —
 * `mint()` is permissionless and the label is free until someone sends the
 * transaction. See db/migrations/003_prepare_before_mint.sql.
 *
 * ## Why the rate limit runs before the signature check
 *
 * The obvious order is the prompt route's — cheap and local first, network
 * last — and it is wrong here. The prompt route's expensive step is a network
 * call it can refuse to make; this route's problem is a caller who never
 * intends to pass validation at all. If refusals are not counted, an attacker
 * sends unsigned rubbish forever, pays nothing, and is never limited, because
 * every one of their requests returns before the counter is reached.
 *
 * So the client-scoped limit is checked first, on the one identifier available
 * before anything is verified, and every attempt that gets past it is recorded
 * whatever its outcome. The owner-scoped limit is enforced only after the
 * signature verifies, and rows are written with a verified owner or none —
 * otherwise anyone could burn a stranger's quota by claiming their address.
 *
 *   1. headers present, body parses          free
 *   2. client + global rate limit            one query
 *   3. timestamp inside the TTL              free
 *   4. body digest matches what was signed   one hash
 *   5. field validation                      free
 *   6. signature recovers === owner          local ecrecover
 *   7. owner rate limit                      reuses the query from 2
 *   8. label is still free on chain          one RPC
 *   9. the writes                            one transaction
 *
 * Every exit from 3 onward records the attempt. An attempt refused at 2 is not
 * recorded: we already know that caller is over, and writing a row per request
 * would turn the limiter into the storage-fill vector it exists to prevent.
 */
import { NextResponse } from "next/server";
import { isAddress, keccak256, recoverMessageAddress, toHex, zeroAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createServerClient } from "@/lib/capsule/chain";
import { loadServerEnv } from "@/lib/capsule/env";
import { parsePrepareRequest, providerOf, RATE_LIMITS } from "@/lib/capsule/prepare";
import { readAddr } from "@/lib/capsule/resolve";
import {
  clientHash,
  countRecentPrepares,
  createStore,
  prepareCapsule,
  recordPrepareAttempt,
  type Store,
} from "@/lib/capsule/store";
import {
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  isPrepareTimestampFresh,
  isSameAddress,
  prepareMessage,
} from "@/lib/capsule/wire";

/** node:crypto, the AES envelope and a keypair generator. Not edge-compatible. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store, no-cache, must-revalidate" };

/** The digest the client signed, sent alongside so we can say which mismatched. */
const HEADER_DIGEST = "x-capsule-digest";

function fail(status: number, error: string, log: string, extra: object = {}): NextResponse {
  console.warn(`prepare deny ${status} — ${log}`);
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
}

/**
 * The caller's address, for rate limiting only.
 *
 * `x-forwarded-for` is a client-supplied header everywhere except behind a proxy
 * that overwrites it, which is what Vercel does. Taking the first entry is right
 * there and forgeable elsewhere — so this bounds abuse in production and is not
 * relied on for anything but counting.
 */
function clientAddressOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded.trim() !== "") return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() ?? "unknown";
}

/**
 * The claimed owner, read before anything is verified.
 *
 * Used only to look up how much that address has *already verifiably* done —
 * rows are never written under an unverified owner, so a caller cannot inflate
 * a stranger's count by claiming their address. The limit itself is not
 * enforced until the signature proves the claim.
 */
function claimedOwner(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>).owner;
  return typeof value === "string" && isAddress(value) ? value.toLowerCase() : "";
}

export async function POST(request: Request): Promise<NextResponse> {
  // --- 1. shape ------------------------------------------------------------
  const timestampHeader = request.headers.get(HEADER_TIMESTAMP);
  const signature = request.headers.get(HEADER_SIGNATURE);
  const digestHeader = request.headers.get(HEADER_DIGEST);

  if (timestampHeader === null || signature === null || digestHeader === null) {
    return fail(400, "missing capsule headers", "missing headers");
  }

  // Read the body as text, once. The digest has to cover the bytes that were
  // actually sent: re-serialising a parsed object would hash a different string
  // than the browser signed the moment the two JSON encoders disagree about key
  // order or unicode escapes.
  const raw = await request.text();
  if (raw.length > 64_000) {
    return fail(413, "request body is too large", `body ${raw.length} bytes`);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "body is not valid JSON", "unparseable body");
  }

  const env = loadServerEnv();
  const store: Store = createStore(env);
  const client = clientHash(store, clientAddressOf(request));

  // --- 2. the limit that does not depend on trusting anything --------------
  let counts;
  try {
    counts = await countRecentPrepares(store, {
      ownerAddress: claimedOwner(body),
      clientHash: client,
      windowSeconds: RATE_LIMITS.windowSeconds,
    });
  } catch (error) {
    console.error(`prepare 500 — rate check failed: ${error instanceof Error ? error.message : "?"}`);
    return NextResponse.json({ error: "internal error" }, { status: 500, headers: NO_STORE });
  }

  if (counts.global >= RATE_LIMITS.perGlobal || counts.client >= RATE_LIMITS.perClient) {
    // Not recorded on purpose: we already know this caller is over, and a row
    // per refused request would make the limiter the storage-fill vector it is
    // supposed to prevent.
    return fail(
      429,
      "too many prepare requests — try again later",
      `client/global limit (client=${counts.client} global=${counts.global})`,
      { retryAfterSeconds: RATE_LIMITS.windowSeconds },
    );
  }

  // From here on every exit is counted, so a caller who only ever fails
  // validation still burns their allowance.
  const outcome = await handle({ env, store, raw, body, timestampHeader, signature, digestHeader, counts });

  await recordPrepareAttempt(store, {
    // Empty unless a signature actually proved it. Recording a claimed owner
    // would let anyone spend a stranger's quota.
    ownerAddress: outcome.owner ?? "",
    clientHash: client,
    capsuleName: outcome.capsuleName ?? "",
    accepted: outcome.response.status === 200,
  }).catch((error) => {
    // A failed audit write must not fail a request that otherwise succeeded,
    // but it must be loud: this is the counter the limiter runs on.
    console.error(`prepare — could not record attempt: ${error instanceof Error ? error.message : "?"}`);
  });

  return outcome.response;
}

type Outcome = { response: NextResponse; owner?: string; capsuleName?: string };

async function handle(input: {
  env: ReturnType<typeof loadServerEnv>;
  store: Store;
  raw: string;
  body: unknown;
  timestampHeader: string;
  signature: string;
  digestHeader: string;
  counts: { owner: number; client: number; global: number };
}): Promise<Outcome> {
  const { env, store, raw, body, timestampHeader, signature, digestHeader, counts } = input;

  // --- 3. freshness --------------------------------------------------------
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || !isPrepareTimestampFresh(timestamp)) {
    return { response: fail(403, "signature expired", `stale timestamp ${timestampHeader}`) };
  }

  // --- 4. the digest covers this body --------------------------------------
  const digest = keccak256(toHex(raw));
  if (digest !== digestHeader) {
    // Either the body changed after signing, or the client hashed it
    // differently. Both are the same refusal: the signature does not cover what
    // arrived, so it authorises nothing.
    return {
      response: fail(403, "the signature does not cover this body", `digest ${digestHeader} != ${digest}`),
    };
  }

  // --- 5. validation, before the signature, because the message names the ---
  //        capsule name and the owner and both come out of the body.
  const parsed = parsePrepareRequest(body, env.defaultParentName);
  if (!parsed.ok) {
    return {
      response: fail(422, "the request has problems", "validation failed", { problems: parsed.problems }),
    };
  }
  const { request: prepared, capsuleName } = parsed;

  // --- 6. signature ---------------------------------------------------------
  let signer;
  try {
    signer = await recoverMessageAddress({
      message: prepareMessage(capsuleName, prepared.owner, digest, timestamp),
      signature: signature as Hex,
    });
  } catch {
    return { response: fail(403, "bad signature", "signature did not recover"), capsuleName };
  }

  if (!isSameAddress(signer, prepared.owner)) {
    // The owner field is what the mint will hand the name to, and it is what the
    // rate limit is filed under. A request signed by one address on behalf of
    // another is refused rather than reinterpreted.
    return {
      response: fail(403, "the signature is not from the stated owner", `${signer} != owner ${prepared.owner}`),
      capsuleName,
    };
  }

  // The claim is proved, so from here the attempt is recorded against it.
  const owner = prepared.owner.toLowerCase();

  // --- 7. the owner-scoped limit -------------------------------------------
  if (counts.owner >= RATE_LIMITS.perOwner) {
    return {
      response: fail(429, "too many prepare requests — try again later", `owner limit (${counts.owner})`, {
        retryAfterSeconds: RATE_LIMITS.windowSeconds,
      }),
      owner,
      capsuleName,
    };
  }

  // --- 8. is the label still free? -----------------------------------------
  //
  // Every capsule minted here has `addr` written in the same transaction that
  // registers it, so a name that resolves to a non-zero address is one that
  // `REGISTRY.register` would revert on. A name registered under this parent by
  // other means may not resolve, and would slip past this check — the mint then
  // reverts, which is the honest outcome for a name we could not have minted
  // anyway.
  try {
    const existing = await readAddr(createServerClient(env.rpcUrl), capsuleName);
    if (existing.address !== zeroAddress) {
      return {
        response: fail(409, `${capsuleName} is already minted`, `resolves to ${existing.address}`),
        owner,
        capsuleName,
      };
    }
  } catch {
    // An unresolvable name is the expected case: there is no resolver for a name
    // that does not exist. Anything else here — an RPC outage — is not a reason
    // to refuse, because this check is an early-out for the user's benefit, not
    // an authorisation. The mint is what actually enforces uniqueness.
  }

  // --- 9. the writes --------------------------------------------------------
  //
  // The agent's keypair is generated here and the private half is sealed
  // immediately. It is never logged, never returned, and never leaves this
  // process in the clear — the caller gets the address, which is what goes on
  // chain, and nothing else.
  const agentPrivateKey = generatePrivateKey();
  const agentAddress = privateKeyToAccount(agentPrivateKey).address;

  let promptRef: string;
  try {
    ({ promptRef } = await prepareCapsule(store, {
      capsuleName,
      owner: prepared.owner,
      agentAddress,
      agentPrivateKey,
      promptBody: prepared.prompt,
      provider: providerOf(prepared),
      providerKey: prepared.providerKey,
      providerMeta: prepared.providerMeta,
      telegramToken: prepared.telegramToken,
    }));
  } catch (error) {
    // Never echo the error: it is a database message and may quote a value.
    console.error(
      `prepare 500 — write failed for ${capsuleName}: ${error instanceof Error ? error.message : "?"}`,
    );
    return {
      response: NextResponse.json({ error: "could not store the capsule" }, { status: 500, headers: NO_STORE }),
      owner,
      capsuleName,
    };
  }

  console.log(`prepare 200 — ${capsuleName} · agent ${agentAddress} · prompt ${promptRef}`);

  // Exactly the arguments the mint needs, and the record values it will write,
  // echoed so the browser builds the transaction from what the server validated
  // rather than from what it had in its own form state.
  return {
    owner,
    capsuleName,
    response: NextResponse.json(
      {
        capsuleName,
        label: prepared.label,
        owner: prepared.owner,
        agent: agentAddress,
        promptRef,
        config: {
          context: prepared.context,
          telegramUrl: prepared.telegramUrl,
          // The API root, not the site root. The runner appends `/prompt/:ref`
          // and `/runtime` to whatever this record says (runner/src/prompt.ts,
          // runner/src/runtime.ts), and Next mounts both under `/api` — so a
          // bare origin here sends the agent to a page that does not exist. It
          // boots, resolves every record, signs correctly, and gets a 404 that
          // `fetchPrompt` reports as "no prompt stored": a missing prefix in
          // the costume of a missing prompt. `dev/prompt-server.ts` serves
          // `/prompt` at its root, which is why the dev loop never sees this.
          capsuleEndpoint: `${env.publicUrl}/api`,
          model: prepared.model,
          runtime: prepared.runtime,
          promptPointer: promptRef,
        },
      },
      { status: 200, headers: NO_STORE },
    ),
  };
}
