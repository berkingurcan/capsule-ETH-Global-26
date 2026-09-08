/**
 * A local stand-in for the capsule control plane. DISPOSABLE.
 *
 * Serves the two endpoints a runner needs to boot — /prompt/:ref and /runtime —
 * against the same signature scheme the real Neon-backed service in web/ uses.
 * What survives is the wire contract in src/prompt.ts and src/runtime.ts, which
 * both sides import rather than restate.
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
import { runtimeFetchMessage } from "../src/runtime.js";

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
  // A second persona to switch to. Point agent-prompt at this one on chain and
  // the next tick makes the same running container a different agent — the
  // 0:50 beat in the demo script, with no redeploy anywhere.
  cap_7b21e9: [
    "You are the fleet's incident reporter.",
    "You describe what changed on chain in the last few minutes and who caused it.",
    "Be terse and factual. Name addresses, records and block numbers.",
    "Never speculate about intent; report the transaction and stop.",
  ].join(" "),
};

/**
 * Stands in for the credential rows. Obviously fake values: this file is committed,
 * and a real bot token in a repo is a real bot token in a repo. Put yours in
 * dev.local.json (gitignored) or export them, and the server reads those instead.
 */
const CREDENTIALS = {
  telegramBotToken: optionalEnv("DEV_TELEGRAM_BOT_TOKEN") ?? "0000000000:DEV-not-a-real-token",
  modelProvider: optionalEnv("DEV_MODEL_PROVIDER") ?? "anthropic",
  modelApiKey: optionalEnv("DEV_MODEL_API_KEY") ?? "sk-ant-dev-not-a-real-key",
  // Numeric Telegram user ids. Never empty: the supervisor refuses to open a bot
  // that anyone can DM, and a dev server that quietly hands back an empty list
  // would hide that refusal until the first deploy.
  allowFrom: (optionalEnv("DEV_TELEGRAM_ALLOW_FROM") ?? "482913756").split(",").map((s) => s.trim()),
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

/**
 * Everything both routes share: headers present, timestamp fresh, signature
 * recovers, and the name's addr record claims the signer. Returns the verified
 * name, or null once it has already answered the request.
 *
 * `message` differs per route and that is the security property — the prompt
 * fetch and the credential fetch are signed over different domain separators, so
 * a signature captured from one does not open the other.
 */
async function authorise(
  req: IncomingMessage,
  res: ServerResponse,
  message: (name: string, timestamp: number) => string,
): Promise<string | null> {
  const name = req.headers["x-capsule-name"];
  const timestampHeader = req.headers["x-capsule-timestamp"];
  const signature = req.headers["x-capsule-signature"];

  if (typeof name !== "string" || typeof timestampHeader !== "string" || typeof signature !== "string") {
    deny(res, 400, "missing capsule headers", "missing headers");
    return null;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || !isTimestampFresh(timestamp)) {
    // A captured request must not work forever.
    deny(res, 403, "signature expired", `stale timestamp ${timestampHeader}`);
    return null;
  }

  let signer;
  try {
    signer = await recoverMessageAddress({
      message: message(name, timestamp),
      signature: signature as Hex,
    });
  } catch {
    deny(res, 403, "bad signature", "signature did not recover");
    return null;
  }

  // The whole authorisation step: does the name claim this signer?
  let claimed;
  try {
    claimed = (await readAddr(client, name)).address;
  } catch {
    console.log(`  502 could not resolve ${name}`);
    send(res, 502, { error: "could not resolve the name" });
    return null;
  }

  if (!isSameAddress(signer, claimed)) {
    deny(res, 403, "the name does not claim this signer", `${signer} != addr ${claimed}`);
    return null;
  }

  return name;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method !== "GET") return send(res, 404, { error: "not found" });

  if (url.pathname === "/runtime") {
    console.log(`GET /runtime for ${String(req.headers["x-capsule-name"])}`);
    const name = await authorise(req, res, runtimeFetchMessage);
    if (name === null) return;
    console.log(`  200 ${CREDENTIALS.modelProvider} · ${CREDENTIALS.allowFrom.length} allowed dm id(s)`);
    return send(res, 200, CREDENTIALS);
  }

  const match = /^\/prompt\/([^/]+)$/.exec(url.pathname);
  if (match === null) return send(res, 404, { error: "not found" });

  const promptRef = decodeURIComponent(match[1]!);
  const name = req.headers["x-capsule-name"];
  const timestampHeader = req.headers["x-capsule-timestamp"];
  const signature = req.headers["x-capsule-signature"];

  console.log(`GET /prompt/${promptRef} for ${String(name)}`);

  const verified = await authorise(req, res, (n, t) => promptFetchMessage(n, promptRef, t));
  if (verified === null) return;

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
  console.log(`capsule control plane on :${PORT}`);
  console.log(`  authorising against addr records on ENSv2 Sepolia`);
  console.log(`  GET /prompt/:ref  — ${Object.keys(PROMPTS).length} stored: ${Object.keys(PROMPTS).join(", ")}`);
  console.log(`  GET /runtime      — ${CREDENTIALS.modelProvider} key, telegram token, ${CREDENTIALS.allowFrom.length} allowed dm id(s)`);
  if (CREDENTIALS.telegramBotToken.includes("not-a-real")) {
    console.log(`  ⚠️  placeholder credentials — set DEV_TELEGRAM_BOT_TOKEN and DEV_MODEL_API_KEY for a live bot`);
  }
});
