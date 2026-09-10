/**
 * Server-side environment for the launchpad, the prompt service and the
 * provisioner. Deliberately mirrors runner/src/env.ts: required means
 * required, and nothing has a silent fallback.
 *
 * The reason is the same one as in the runner, one layer up. A provisioner
 * that quietly substitutes a default boots a machine against the wrong app,
 * or writes an endpoint record pointing at localhost, and the failure surfaces
 * three steps later as an agent that cannot fetch its prompt. Fail here, where
 * the message can name the variable.
 *
 * This module is server-only. It reads secrets, so it refuses to load in a
 * browser. The `server-only` package would be the idiomatic guard, but it
 * resolves to a throwing module outside Next's react-server condition, which
 * would take the standalone preflight script down with it. A window check
 * costs one line and holds in every context we actually run in.
 */
import { getAddress, isHex, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parentNameProblems } from "./parent";

if (typeof window !== "undefined") {
  throw new Error("lib/capsule/env is server-only and was imported in a browser");
}

export class MissingEnvError extends Error {
  readonly varName: string;
  constructor(varName: string) {
    super(`${varName} is not set`);
    this.name = "MissingEnvError";
    this.varName = varName;
  }
}

export class InvalidEnvError extends Error {
  readonly varName: string;
  constructor(varName: string, reason: string) {
    super(`${varName} ${reason}`);
    this.name = "InvalidEnvError";
    this.varName = varName;
  }
}

export function requireEnv(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") throw new MissingEnvError(name);
  return raw.trim();
}

export function optionalEnv(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}

function requireUrl(name: string): string {
  const value = requireEnv(name);
  try {
    new URL(value);
  } catch {
    throw new InvalidEnvError(name, "is not a URL");
  }
  return value;
}

/** 32 bytes, base64. The AES-256-GCM key wrapping every row in the store. */
function requireMasterKey(name: string): Buffer {
  const raw = requireEnv(name);
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new InvalidEnvError(name, "is not base64");
  }
  if (key.length !== 32) {
    throw new InvalidEnvError(
      name,
      `must decode to 32 bytes for AES-256, got ${key.length}`,
    );
  }
  return key;
}

export type ServerEnv = {
  rpcUrl: string;
  /** Neon connection string. Pooled endpoint — this runs on serverless. */
  databaseUrl: string;
  masterKey: Buffer;

  flyApiToken: string;
  flyAppName: string;
  flyRegion: string;
  /** Defaults to the app's own Fly registry tag; override to pin a digest. */
  runnerImage: string;

  minterAddress: Address;
  /**
   * The block the minter was deployed in.
   *
   * `readFleet` enumerates capsules from `CapsuleMinted` logs, and a public RPC
   * will refuse — or silently truncate — a scan from block 0. It is configured
   * rather than hardcoded for the same reason the minter address is: a redeploy
   * moves both, and a stale constant here returns an empty fleet rather than an
   * error. Read it off `contracts/broadcast/DeployCapsuleMinter.s.sol`.
   */
  minterBlock: bigint;
  /**
   * e.g. "capsulefleet.eth" — the name the launch form opens on and the fleet
   * dashboard shows when nothing else is asked for.
   *
   * A DEFAULT, not a limit. `CapsuleMinter` serves every name whose owner has
   * connected it, and the launch form, both API routes and `/fleet` all take a
   * parent per request. This is here so the app has something to show a visitor
   * who has not connected a name of their own, and so the demo has a front door.
   *
   * It is still required. A deployment with no default would render a launch
   * form with an empty parent field and no way to guess one, and "which name?"
   * is a worse first question than "here is ours, or use yours".
   */
  defaultParentName: string;
  /**
   * The origin written into `agent-endpoint[capsule]` at mint time, and therefore the
   * URL a booted runner will call for its prompt. On Vercel this is the
   * deployment's own public URL; it is NOT derivable at runtime in a way we
   * would want to trust, so it is configured.
   */
  publicUrl: string;
};

export function loadServerEnv(): ServerEnv {
  const flyAppName = requireEnv("FLY_APP_NAME");

  let minterAddress: Address;
  try {
    minterAddress = getAddress(requireEnv("CAPSULE_MINTER_ADDRESS"));
  } catch (error) {
    if (error instanceof MissingEnvError) throw error;
    throw new InvalidEnvError("CAPSULE_MINTER_ADDRESS", "is not an EVM address");
  }

  const rawBlock = requireEnv("CAPSULE_MINTER_BLOCK");
  if (!/^\d+$/.test(rawBlock)) {
    throw new InvalidEnvError("CAPSULE_MINTER_BLOCK", "must be a decimal block number");
  }
  const minterBlock = BigInt(rawBlock);

  // Validated with the same function the parent field in the browser uses, so a
  // name this rejects is exactly a name the form would reject. The rule is
  // second-level `.eth`, and `parentNameProblems` explains why.
  const defaultParentName = requireEnv("CAPSULE_PARENT_NAME").toLowerCase();
  const parentProblems = parentNameProblems(defaultParentName);
  if (parentProblems.length > 0) {
    throw new InvalidEnvError("CAPSULE_PARENT_NAME", parentProblems[0]);
  }

  // The browser gets its own copy of this one value (lib/capsule/public-env.ts),
  // because env.ts refuses to load client-side. Two copies drift, so they are
  // asserted against each other here — the same guard the record keys get. A
  // mismatch means the launch form opens on a different name than the one the
  // API routes would treat as the default.
  const publicParentName = optionalEnv("NEXT_PUBLIC_CAPSULE_PARENT_NAME");
  if (publicParentName !== undefined && publicParentName.toLowerCase() !== defaultParentName) {
    throw new InvalidEnvError(
      "NEXT_PUBLIC_CAPSULE_PARENT_NAME",
      `is "${publicParentName}" but CAPSULE_PARENT_NAME is "${defaultParentName}" — they must match`,
    );
  }

  return {
    rpcUrl: requireUrl("SEPOLIA_RPC_URL"),
    databaseUrl: requireEnv("DATABASE_URL"),
    masterKey: requireMasterKey("SECRET_MASTER_KEY"),

    flyApiToken: requireEnv("FLY_API_TOKEN"),
    flyAppName,
    flyRegion: optionalEnv("FLY_REGION") ?? "ord",
    runnerImage: optionalEnv("RUNNER_IMAGE") ?? `registry.fly.io/${flyAppName}:latest`,

    minterAddress,
    minterBlock,
    defaultParentName,
    publicUrl: requireUrl("CAPSULE_PUBLIC_URL").replace(/\/+$/, ""),
  };
}

////////////////////////////////////////////////////////////////////////////
// The provisioner
////////////////////////////////////////////////////////////////////////////

/**
 * What `POST /api/capsule/provision` needs, and nothing else needs.
 *
 * Kept out of `ServerEnv` on purpose. `loadServerEnv()` runs on every page
 * render and in every route, so a variable added there is a variable that must
 * be set before the fleet dashboard will draw — and the funder key is required
 * by exactly one endpoint. Folding it in would mean a deployment that only
 * wants to mint could not render a page for want of a wallet it never spends.
 *
 * Everything here still fails loudly. The provisioner sends real ETH and starts
 * a real machine; a defaulted funding amount or a silently-halved memory limit
 * would be discovered as an agent that stops beating, or as an OOM that looks
 * like a clean restart.
 */
export type ProvisionerEnv = {
  /** Pays each agent's heartbeat. The only key this codebase signs with. */
  funderKey: Hex;
  funderAddress: Address;
  /** Every agent is topped up to this balance, not sent this much. */
  agentFundingWei: bigint;
  /** Never below 1024 — see GATE-LOG.md. 842 MiB measured, and 512 OOMs quietly. */
  machineMemoryMb: number;
  tickSeconds: number;
  heartbeatSeconds: number;
};

export function loadProvisionerEnv(): ProvisionerEnv {
  const rawKey = requireEnv("CAPSULE_FUNDER_KEY");
  const funderKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
  if (!isHex(funderKey) || funderKey.length !== 66) {
    throw new InvalidEnvError("CAPSULE_FUNDER_KEY", "is not a 32-byte hex private key");
  }
  const funderAddress = privateKeyToAccount(funderKey).address;

  // Decimal ETH rather than wei, because this is a number a person sets by
  // hand and 10000000000000000 is a number a person mistypes by hand.
  const rawFunding = optionalEnv("CAPSULE_AGENT_FUNDING_ETH") ?? "0.01";
  if (!/^\d+(\.\d+)?$/.test(rawFunding)) {
    throw new InvalidEnvError("CAPSULE_AGENT_FUNDING_ETH", "must be a decimal amount of ETH");
  }
  const agentFundingWei = parseEther(rawFunding);
  if (agentFundingWei === 0n) {
    // An agent with no gas cannot write `agent-heartbeat`, and a heartbeat that
    // fails for want of gas is the one failure this system must never let look
    // like a revocation. Refuse the configuration that guarantees it.
    throw new InvalidEnvError("CAPSULE_AGENT_FUNDING_ETH", "is zero — an agent with no gas cannot beat");
  }

  const rawMemory = optionalEnv("FLY_MACHINE_MEMORY_MB") ?? "2048";
  if (!/^\d+$/.test(rawMemory)) {
    throw new InvalidEnvError("FLY_MACHINE_MEMORY_MB", "must be a whole number of megabytes");
  }
  const machineMemoryMb = Number(rawMemory);
  if (machineMemoryMb < 1024) {
    throw new InvalidEnvError(
      "FLY_MACHINE_MEMORY_MB",
      `is ${machineMemoryMb} — the gateway, supervisor and Codex measured 842 MiB together, ` +
        "so anything under 1024 OOMs on the first conversation and the restart looks like a clean boot",
    );
  }

  const rawTick = optionalEnv("CAPSULE_TICK_SECONDS") ?? "30";
  const tickSeconds = Number(rawTick);
  if (!Number.isSafeInteger(tickSeconds) || tickSeconds < 5) {
    throw new InvalidEnvError("CAPSULE_TICK_SECONDS", "must be a whole number of seconds, at least 5");
  }

  const rawBeat = optionalEnv("CAPSULE_HEARTBEAT_SECONDS") ?? "28800";
  const heartbeatSeconds = Number(rawBeat);
  if (!Number.isSafeInteger(heartbeatSeconds) || heartbeatSeconds < 5) {
    throw new InvalidEnvError("CAPSULE_HEARTBEAT_SECONDS", "must be a whole number of seconds, at least 5");
  }
  // The runner refuses this combination at boot (runner/src/env.ts). Refusing it
  // here too means the operator finds out at deploy time rather than from a
  // container that started and then died with a config error.
  if (heartbeatSeconds < tickSeconds) {
    throw new InvalidEnvError(
      "CAPSULE_HEARTBEAT_SECONDS",
      `is ${heartbeatSeconds}s but CAPSULE_TICK_SECONDS is ${tickSeconds}s — ` +
        "the loop cannot beat faster than it ticks",
    );
  }

  return { funderKey, funderAddress, agentFundingWei, machineMemoryMb, tickSeconds, heartbeatSeconds };
}

////////////////////////////////////////////////////////////////////////////
// The analyst
////////////////////////////////////////////////////////////////////////////

/**
 * What `POST /api/analyst` needs, and nothing else needs.
 *
 * Kept out of `ServerEnv` for the same reason the funder key is: `loadServerEnv()`
 * runs on every page render, and a deployment that never opens /analyst should
 * not fail to draw a dashboard for want of two API keys.
 *
 * `SUBGRAPH_URL` is deliberately NOT in here even though the analyst is about
 * the same subgraph. The fleet dashboard queries the index directly over its
 * Studio query URL; the analyst reaches it through The Graph's hosted Subgraph
 * MCP server, which addresses subgraphs by id and authenticates with a gateway
 * key. Two different credentials for two different doors, and collapsing them
 * into one variable would mean setting a key that one of the two paths cannot
 * use.
 */
export type AnalystEnv = {
  anthropicApiKey: string;
  /** A Graph gateway API key from Subgraph Studio. Never reaches the browser. */
  graphApiKey: string;
  /**
   * The subgraph's id in Subgraph Studio — what `execute_query_by_subgraph_id`
   * takes, and what pins the analyst to the fleet rather than to whichever
   * subgraph a keyword search happened to surface.
   */
  subgraphId: string;
};

export function loadAnalystEnv(): AnalystEnv {
  const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");
  const graphApiKey = requireEnv("GRAPH_API_KEY");
  const subgraphId = requireEnv("SUBGRAPH_ID");

  // Studio subgraph ids are base58 and about 46 characters. The check is loose
  // on purpose — the format is not ours to pin — but a URL pasted in here is a
  // mistake worth catching, because the failure it causes is the MCP server
  // reporting that no such subgraph exists, several seconds into a stream.
  if (subgraphId.includes("/") || subgraphId.includes(":")) {
    throw new InvalidEnvError(
      "SUBGRAPH_ID",
      "looks like a URL — it is the subgraph's id in Subgraph Studio, not its query endpoint",
    );
  }

  return { anthropicApiKey, graphApiKey, subgraphId };
}
