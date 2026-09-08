/**
 * Environment loading for the Capsule runner.
 *
 * The runner is configured by environment variables and nothing else — no config
 * file. In development `dotenv` fills `process.env` from `runner/.env`; in
 * production the provisioner hands the same keys to a Fly machine at creation
 * time. The code cannot tell the difference, which is the point.
 *
 * Every value is required. There are no fallbacks and no defaults: a runner that
 * quietly substitutes a value it was not given is a runner that fails in a way
 * that looks like a revoked permission.
 */
import { getAddress, isHex, type Address, type Hex } from "viem";

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

/** Reads a variable, or throws naming it. Never returns an empty string. */
export function requireEnv(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") throw new MissingEnvError(name);
  return raw.trim();
}

/** Reads a variable if it is set. Undefined is a valid answer; "" is not. */
export function optionalEnv(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}

export type RunnerEnv = {
  rpcUrl: string;
  /** The AGENT key — deliberately the least privileged key in the system. */
  agentKey: Hex;
  agentAddress: Address;
  capsuleName: string;
  /** Seconds between authorization probes. Free, so this can be brisk. */
  tickSeconds: number;
  /**
   * Seconds between on-chain heartbeat writes. Default 28800 — three a day.
   *
   * This is the number that costs money, and it is deliberately far apart from
   * `tickSeconds`. Measured at 48,423 gas a write: three a day is ~0.05 ETH/year per
   * agent at 10 gwei on mainnet; one every 30 seconds is ~54 ETH/year, which is not a
   * product. The free probe covers the gap, so revocation is still caught in seconds.
   *
   * Turn it down for a demo — 60 makes the counter move on camera. That is one
   * environment variable, not a code change, which is the honest answer when asked
   * why the dashboard is not live.
   */
  heartbeatSeconds: number;
  /**
   * Development only: talk to a local prompt service instead of the endpoint
   * published on the name. Not a fallback — it applies only when explicitly
   * set, and every caller announces it in the logs when it is. The record on
   * chain stays the source of truth for a deployed agent.
   */
  endpointOverride: string | undefined;
};

export function loadEnv(): RunnerEnv {
  const rpcUrl = requireEnv("SEPOLIA_RPC_URL");
  try {
    new URL(rpcUrl);
  } catch {
    throw new InvalidEnvError("SEPOLIA_RPC_URL", "is not a URL");
  }

  // Accept a key with or without the 0x prefix, but nothing else. viem's
  // privateKeyToAccount requires the prefix and will happily accept a
  // wrong-length value, so check the shape here rather than downstream.
  const rawKey = requireEnv("AGENT_KEY");
  const agentKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
  if (!isHex(agentKey) || agentKey.length !== 66) {
    throw new InvalidEnvError("AGENT_KEY", "is not a 32-byte hex private key");
  }

  let agentAddress: Address;
  try {
    agentAddress = getAddress(requireEnv("AGENT_ADDRESS"));
  } catch (error) {
    if (error instanceof MissingEnvError) throw error;
    throw new InvalidEnvError("AGENT_ADDRESS", "is not an EVM address");
  }

  const capsuleName = requireEnv("CAPSULE_NAME");
  if (!capsuleName.endsWith(".eth") || capsuleName.split(".").length < 3) {
    throw new InvalidEnvError(
      "CAPSULE_NAME",
      "must be a subname such as analyst.capsulefleet.eth",
    );
  }

  const rawTick = optionalEnv("TICK_SECONDS") ?? "30";
  const tickSeconds = Number(rawTick);
  if (!Number.isSafeInteger(tickSeconds) || tickSeconds < 5) {
    throw new InvalidEnvError("TICK_SECONDS", "must be a whole number of seconds, at least 5");
  }

  // 28800 = three writes a day. The floor is 30 rather than 5: a heartbeat interval
  // shorter than a Sepolia block time would queue transactions on the same nonce and
  // cancel its own writes, and the failure would read as an unhealthy agent.
  const rawHeartbeat = optionalEnv("HEARTBEAT_SECONDS") ?? "28800";
  const heartbeatSeconds = Number(rawHeartbeat);
  if (!Number.isSafeInteger(heartbeatSeconds) || heartbeatSeconds < 30) {
    throw new InvalidEnvError(
      "HEARTBEAT_SECONDS",
      "must be a whole number of seconds, at least 30",
    );
  }

  const endpointOverride = optionalEnv("CAPSULE_ENDPOINT_OVERRIDE");
  if (endpointOverride !== undefined) {
    try {
      new URL(endpointOverride);
    } catch {
      throw new InvalidEnvError("CAPSULE_ENDPOINT_OVERRIDE", "is not a URL");
    }
  }

  return {
    rpcUrl,
    agentKey,
    agentAddress,
    capsuleName,
    tickSeconds,
    heartbeatSeconds,
    endpointOverride,
  };
}
