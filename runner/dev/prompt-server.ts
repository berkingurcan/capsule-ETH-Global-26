/**
 * A local stand-in for the prompt service. DISPOSABLE.
 *
 * Build step 4 replaces this with the real Neon-backed service behind the
 * launchpad. What survives is the wire contract in src/prompt.ts, which both
 * sides import rather than restate.
 *
 * Note what this process does not have: a key, a session table, a list of
 * agents, or any secret shared with the runner. It authorises a request by
 * recovering the signer and asking ENS whether that address is who the name
 * says it is. The authorisation database is the protocol.
 */
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { recoverMessageAddress, type Hex } from "viem";
import { createRunnerClient } from "../src/chain.js";
import { optionalEnv, requireEnv } from "../src/env.js";
import { isSameAddress, isTimestampFresh, promptFetchMessage } from "../src/prompt.js";
import { readAddr } from "../src/resolve.js";

const PORT = Number(optionalEnv("PROMPT_PORT") ?? 8787);
const client = createRunnerClient(requireEnv("SEPOLIA_RPC_URL"));

/** Stands in for Postgres. In production these rows are encrypted at rest. */
const PROMPTS: Record<string, string> = {
  cap_8f3d1a: [
    "You are the analyst for a small ENS-native agent fleet.",
    "You watch ETH/USDC on Sepolia and report what changed and why it might matter.",
    "Answer in at most four sentences. Lead with the number, then the reading.",
    "If you do not have the data to answer, say so plainly rather than guessing.",
    "You know your own name and the records that configure you; you cannot change them.",
  ].join(" "),
  // A second persona to switch to. Point agent.prompt at this one on chain and
  // the next tick makes the same running container a different agent — the
  // 0:50 beat in the demo script, with no redeploy anywhere.
  cap_7b21e9: [
    "You are the fleet's incident reporter.",
    "You describe what changed on chain in the last few minutes and who caused it.",
    "Be terse and factual. Name addresses, records and block numbers.",
    "Never speculate about intent; report the transaction and stop.",
  ].join(" "),
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
};

/** Never includes the prompt body, and never says which check failed. */
const deny = (res: ServerResponse, status: number, reason: string, log: string) => {
  console.log(`  ${status} ${log}`);
  send(res, status, { error: reason });
};

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const match = /^\/prompt\/([^/]+)$/.exec(url.pathname);

  if (req.method !== "GET" || match === null) {
    return send(res, 404, { error: "not found" });
  }

  const promptRef = decodeURIComponent(match[1]!);
  const name = req.headers["x-capsule-name"];
  const timestampHeader = req.headers["x-capsule-timestamp"];
  const signature = req.headers["x-capsule-signature"];

  console.log(`GET /prompt/${promptRef} for ${String(name)}`);

  if (typeof name !== "string" || typeof timestampHeader !== "string" || typeof signature !== "string") {
    return deny(res, 400, "missing capsule headers", "missing headers");
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || !isTimestampFresh(timestamp)) {
    // A captured request must not work forever.
    return deny(res, 403, "signature expired", `stale timestamp ${timestampHeader}`);
  }

  let signer;
  try {
    signer = await recoverMessageAddress({
      message: promptFetchMessage(name, promptRef, timestamp),
      signature: signature as Hex,
    });
  } catch {
    return deny(res, 403, "bad signature", "signature did not recover");
  }

  // The whole authorisation step: does the name claim this signer?
  let claimed;
  try {
    claimed = (await readAddr(client, name)).address;
  } catch (error) {
    console.log(`  502 could not resolve ${name}`);
    return send(res, 502, { error: "could not resolve the name" });
  }

  if (!isSameAddress(signer, claimed)) {
    return deny(res, 403, "the name does not claim this signer", `${signer} != addr ${claimed}`);
  }

  const prompt = PROMPTS[promptRef];
  if (prompt === undefined) {
    // Distinct from 403 on purpose: an unknown pointer is a config problem the
    // owner can fix, not a permission problem.
    return deny(res, 404, "no prompt stored for this pointer", "unknown pointer");
  }

  console.log(`  200 ${prompt.length} chars`);
  send(res, 200, { prompt });
}

createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(`  500 ${error instanceof Error ? error.message : String(error)}`);
    send(res, 500, { error: "internal error" });
  });
}).listen(PORT, () => {
  console.log(`prompt service on :${PORT}`);
  console.log(`  authorising against addr records on ENSv2 Sepolia`);
  console.log(`  ${Object.keys(PROMPTS).length} prompt(s) stored: ${Object.keys(PROMPTS).join(", ")}`);
});
