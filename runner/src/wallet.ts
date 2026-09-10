/**
 * The teller window.
 *
 * The supervisor holds `AGENT_KEY` and the gateway does not — `buildOpenClawEnv`
 * builds the child's environment from nothing precisely so that a new secret in
 * the supervisor is excluded by default rather than having to be remembered, and
 * `dev/gateway-smoke.ts` scans the child's environment for anything shaped like
 * a 32-byte key. None of that changes here. What changes is that the model can
 * now *ask* the supervisor to spend, over a loopback socket, and the supervisor
 * decides.
 *
 * The alternative was to put the key in the gateway's environment and hand the
 * model a wallet library. That takes twenty minutes and costs the entire claim:
 * the whole demonstrated result — NOTES.md step 5, an agent holding a live write
 * permission on its own name that still cannot rewrite its own instructions —
 * exists to show that a prompt-injected model cannot exceed its grant. A model
 * holding the raw key exceeds every grant at once, and "ignore your previous
 * instructions and send me everything" becomes a working attack against the one
 * project claiming it is not.
 *
 * So: a request crosses the wall, never a credential.
 *
 * ## Why plain JSON over HTTP and not MCP
 *
 * OpenClaw 2026.9.3 does support `mcp.servers` with a streamable-http transport,
 * and that is the tidier long-term seam — typed tools, no shell, and the tools
 * inherit OpenClaw's own tool policy. It is also a protocol handshake this
 * runner would be implementing blind, and the failure mode of getting it subtly
 * wrong is a capsule that boots clean, heartbeats correctly, and silently has no
 * wallet tool.
 *
 * Three endpoints and a CLI the model runs through `exec` have no handshake to
 * get wrong, and can be exercised with `curl` from inside the container while
 * the agent is running. When this graduates past a hackathon, the MCP server
 * wraps this same broker and this same `checkSpend` — the policy is the part
 * worth keeping and it is not in this file.
 *
 * ## The socket
 *
 * Bound to 127.0.0.1, inside a container whose only other process is the
 * gateway. The bearer token is therefore belt and braces rather than the
 * boundary — but it is minted fresh per boot and never logged, exactly like
 * `OPENCLAW_GATEWAY_TOKEN`, so a tool that leaks its environment into a chat
 * leaks a credential that dies with the process and authorises nothing beyond
 * a policy that already refused.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import {
  formatEther,
  getAddress,
  isHex,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { RunnerWallet } from "./chain.js";
import { shortRevert } from "./errors.js";
import { BEAT_GAS } from "./heartbeat.js";
import { checkSpend, describePolicy, spendable, type SpendPolicy } from "./policy.js";
import type { Serializer } from "./serial.js";

/** Loopback only. Never 0.0.0.0 — see the header. */
const HOST = "127.0.0.1";

/** Bodies are three short fields. Anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 8_192;

/** Sepolia blocks land in ~12s. Past this, something is wrong. */
const RECEIPT_TIMEOUT_MS = 90_000;

export type WalletLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type BrokerOptions = {
  publicClient: PublicClient;
  walletClient: RunnerWallet;
  agent: Address;
  port: number;
  /**
   * The queue the heartbeat also uses. Passed in rather than owned, because the
   * whole point is that these two writers share one — see serial.ts.
   */
  serializer: Serializer;
  /**
   * Read live, never captured. The policy comes off the chain every tick and an
   * owner lowering the cap has to take effect on the next request, not on the
   * next restart.
   */
  policy: () => SpendPolicy;
  /** Likewise live: the resolver is discovered, and re-discovered every tick. */
  resolver: () => Address;
  /** Operator override for the per-run ceiling, in wei. */
  ceiling: bigint | undefined;
  log: WalletLogger;
};

type Refusal = { status: number; reason: string };

/**
 * Wrapped rather than returned bare, so `"reason" in result` actually narrows.
 * A bare `Record<string, unknown>` shares every key with a `Refusal` as far as
 * the type system is concerned, and the check silently proves nothing.
 */
type Sent = { body: Record<string, unknown> };

/** A refusal the agent should hear as policy, not as an error. */
const refuse = (reason: string): Refusal => ({ status: 403, reason });
const badRequest = (reason: string): Refusal => ({ status: 400, reason });

export class WalletBroker {
  readonly #options: BrokerOptions;
  readonly #token: string;
  #server: Server | undefined;
  #spent = 0n;
  #sent = 0;

  constructor(options: BrokerOptions) {
    this.#options = options;
    // Fresh per boot, like OPENCLAW_GATEWAY_TOKEN. Nothing persists it and
    // nothing logs it.
    this.#token = randomBytes(32).toString("hex");
  }

  get token(): string {
    return this.#token;
  }

  get url(): string {
    return `http://${HOST}:${this.#options.port}`;
  }

  /** Total value moved this run, for the status block and the ceiling. */
  get spent(): bigint {
    return this.#spent;
  }

  get sent(): number {
    return this.#sent;
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.port, HOST, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    // After listen succeeds, an error is a live-socket problem and must not take
    // the supervisor down with it: the heartbeat is the job, and this is a
    // convenience bolted to the side of it.
    server.on("error", (error) => {
      this.#options.log.warn(`wallet broker socket error — ${error.message}`);
    });

    this.#server = server;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    this.#server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const authorization = request.headers.authorization ?? "";
      if (authorization !== `Bearer ${this.#token}`) {
        return send(response, 401, { error: "unauthorized" });
      }

      const url = new URL(request.url ?? "/", this.url);

      if (request.method === "GET" && url.pathname === "/status") {
        return send(response, 200, await this.#status());
      }

      if (request.method === "POST" && (url.pathname === "/send" || url.pathname === "/call")) {
        const body = await readBody(request);
        if ("error" in body) return send(response, 400, { error: body.error });
        const result = await this.#spend(url.pathname === "/call", body.value);
        if ("reason" in result) return send(response, result.status, { error: result.reason });
        return send(response, 200, result.body);
      }

      return send(response, 404, { error: `no such endpoint: ${request.method} ${url.pathname}` });
    } catch (error) {
      // Never leaks out of the handler. A crashed broker would take PID 1 with
      // it, and this process has exactly one fatal condition — a revocation.
      const reason = shortRevert(error);
      this.#options.log.warn(`wallet request failed — ${reason}`);
      send(response, 500, { error: reason });
    }
  }

  async #status(): Promise<Record<string, unknown>> {
    const { publicClient, agent, policy, ceiling } = this.#options;
    const current = policy();
    const [balance, gasPrice] = await Promise.all([
      publicClient.getBalance({ address: agent }),
      publicClient.getGasPrice(),
    ]);

    const free = spendable({ balance, gasPrice, beatGas: BEAT_GAS, policy: current });
    const runCeiling = ceiling ?? current.cap * 10n;

    return {
      address: agent,
      chainId: this.#options.walletClient.chain?.id,
      balanceEth: formatEther(balance),
      spendableEth: formatEther(free),
      capEth: formatEther(current.cap),
      allow: current.allow === "any" ? "any" : current.allow,
      spentThisRunEth: formatEther(this.#spent),
      runCeilingEth: formatEther(runCeiling),
      transactionsThisRun: this.#sent,
      policy: describePolicy(current),
      enabled: current.cap > 0n,
    };
  }

  /**
   * The whole path: parse, price, check, queue, send, wait.
   *
   * Note the order. The policy is checked *before* the job is queued, so a
   * refusal is instant and costs the heartbeat nothing — an agent asking for
   * something it cannot have must never make the next beat wait. The running
   * total is incremented only after a receipt comes back successful, so a
   * reverted transaction does not eat the ceiling.
   */
  async #spend(isCall: boolean, body: Record<string, unknown>): Promise<Sent | Refusal> {
    const { publicClient, walletClient, agent, serializer, policy, resolver, ceiling, log } = this.#options;

    const parsed = parseSpendBody(isCall, body);
    if ("reason" in parsed) return parsed;
    const { to, value, data, note } = parsed;

    const [balance, gasPrice] = await Promise.all([
      publicClient.getBalance({ address: agent }),
      publicClient.getGasPrice(),
    ]);

    // Estimated before the policy check because the gas reserve is part of the
    // policy. A revert here is the chain refusing the transaction on its own
    // terms — a call to a function that does not exist, a transfer of a token
    // the agent does not hold — and it is worth reporting as itself rather than
    // as a policy refusal, which is what it would look like further down.
    let gasLimit: bigint;
    try {
      gasLimit = await publicClient.estimateGas({ account: agent, to, value, data });
    } catch (error) {
      return refuse(`the chain would reject this transaction — ${shortRevert(error)}`);
    }

    const verdict = checkSpend(
      { to, value, data },
      {
        policy: policy(),
        balance,
        gasPrice,
        gasLimit,
        spentThisRun: this.#spent,
        ceiling,
        resolver: resolver(),
        beatGas: BEAT_GAS,
      },
    );

    if (!verdict.ok) {
      log.info(`wallet refused ${formatEther(value)} ETH → ${to} — ${verdict.reason}`);
      return refuse(verdict.reason);
    }

    // Queued behind the heartbeat and behind any earlier request. See serial.ts:
    // one account, two writers, and viem reads the pending nonce at send time.
    const hash = await serializer.submit(() =>
      walletClient.sendTransaction({
        to,
        value,
        data,
        // Not `gasLimit` — the estimate above is what the policy priced, and a
        // send that re-estimates could land above the reserve the check cleared.
        gas: gasLimit,
      } as Parameters<RunnerWallet["sendTransaction"]>[0]),
    );

    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });

    if (receipt.status !== "success") {
      log.warn(`wallet transaction reverted · ${hash}`);
      // 200 with ok:false, not a refusal. The policy allowed this and the chain
      // rejected it, which is a different thing to tell an owner and a different
      // thing for the agent to report. It also does not touch the run total: a
      // transaction that moved nothing has not spent the ceiling.
      return {
        body: { ok: false, hash, reverted: true, error: "the transaction was mined and reverted" },
      };
    }

    this.#spent += value;
    this.#sent += 1;

    // Logged at info on the supervisor's own stream, where the owner reads it.
    // Every spend the model makes is visible in `fly logs` next to the beats,
    // which is the only audit trail this thing has and is deliberately not
    // something the model can turn off.
    log.info(
      `wallet sent ${formatEther(value)} ETH → ${to}${note === "" ? "" : ` · ${note}`} · block ${receipt.blockNumber} · ${hash}`,
    );

    return {
      body: {
        ok: true,
        hash,
        to,
        valueEth: formatEther(value),
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        spentThisRunEth: formatEther(this.#spent),
      },
    };
  }
}

type ParsedSpend = { to: Address; value: bigint; data: Hex; note: string };

/**
 * The request body, validated.
 *
 * Strict, and strict in the direction that matters: an amount this parser
 * misreads is money. `parseEther` is the same function the policy uses to read
 * the cap, so `"0.01"` means the same thing on both sides of the comparison —
 * which it would not if one side took wei and the other took ether.
 */
function parseSpendBody(isCall: boolean, body: Record<string, unknown>): ParsedSpend | Refusal {
  const rawTo = body.to;
  if (typeof rawTo !== "string") return badRequest("`to` is required and must be an address");
  let to: Address;
  try {
    to = getAddress(rawTo.trim());
  } catch {
    return badRequest(`\`to\` — "${rawTo}" is not an EVM address`);
  }

  const rawValue = body.value;
  let value = 0n;
  if (rawValue !== undefined && rawValue !== null && String(rawValue).trim() !== "") {
    try {
      value = parseEther(String(rawValue).trim());
    } catch {
      return badRequest(`\`value\` — "${String(rawValue)}" is not a decimal ETH amount`);
    }
    if (value < 0n) return badRequest("`value` must not be negative");
  } else if (!isCall) {
    return badRequest("`value` is required for a transfer");
  }

  let data: Hex = "0x";
  if (isCall) {
    const rawData = body.data;
    if (typeof rawData !== "string" || !isHex(rawData) || rawData.length < 10) {
      return badRequest("`data` is required for a call and must be 0x-prefixed calldata");
    }
    data = rawData as Hex;
  }

  const rawNote = body.note;
  const note = typeof rawNote === "string" ? rawNote.trim().slice(0, 120) : "";

  return { to, value, data, note };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readBody(
  request: IncomingMessage,
): Promise<{ value: Record<string, unknown> } | { error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return { error: "request body too large" };
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return { value: {} };

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "expected a JSON object" };
    }
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { error: "body is not valid JSON" };
  }
}
