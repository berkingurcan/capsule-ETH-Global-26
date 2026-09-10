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
import { getAddress, isHex, parseEther, type Address, type Hex } from "viem";

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
  /** Seconds between authorization probes. A free eth_call, so this is brisk. */
  tickSeconds: number;
  /**
   * Seconds between on-chain heartbeat writes. Costs gas, so it is not brisk:
   * three times a day in production, and one environment variable away from
   * once a minute when a demo needs the dashboard to move.
   */
  heartbeatSeconds: number;
  /**
   * Development only: talk to a local prompt service instead of the endpoint
   * published on the name. Not a fallback — it applies only when explicitly
   * set, and every caller announces it in the logs when it is. The record on
   * chain stays the source of truth for a deployed agent.
   */
  endpointOverride: string | undefined;
  /**
   * The loopback port the wallet broker listens on, or undefined when the
   * operator turned it off with `CAPSULE_WALLET=off`.
   *
   * Off is a real position and not the same as a zero cap. A zero cap is the
   * owner saying "not now" on chain and is reversible with one setText; this is
   * the operator saying the capability does not exist in this deployment, and
   * with it unset the broker never starts, the CLI is never on the child's PATH
   * and the skill file is never written. An agent that cannot find the tool
   * says so honestly rather than reporting a permission problem.
   */
  walletPort: number | undefined;
  /**
   * Total value this process may move in one run, in wei. Optional — unset
   * means ten times whatever the on-chain cap currently is. See
   * DEFAULT_CEILING_MULTIPLE in policy.ts for why a ceiling exists at all.
   */
  spendCeiling: bigint | undefined;
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

  // Default 28800 — 3 beats a day. The write is the liveness record, not the
  // liveness check: the probe on every tick is what catches a revocation, and
  // this is what leaves a trace of it on chain.
  const rawBeat = optionalEnv("HEARTBEAT_SECONDS") ?? "28800";
  const heartbeatSeconds = Number(rawBeat);
  if (!Number.isSafeInteger(heartbeatSeconds) || heartbeatSeconds < 5) {
    throw new InvalidEnvError("HEARTBEAT_SECONDS", "must be a whole number of seconds, at least 5");
  }
  // The loop can only beat on a tick boundary, so a shorter interval than the
  // tick does not beat faster — it beats every tick and silently ignores what
  // it was asked for. Refuse rather than pretend.
  if (heartbeatSeconds < tickSeconds) {
    throw new InvalidEnvError(
      "HEARTBEAT_SECONDS",
      `is ${heartbeatSeconds}s but TICK_SECONDS is ${tickSeconds}s — the loop cannot beat faster than it ticks`,
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

  // Defaulted rather than required, unlike everything above it. The rule that
  // every value must be given exists so a runner cannot quietly substitute a
  // value that changes what it *is* — a name, a key, an endpoint. A loopback
  // port number is not one of those: it is invisible outside the container and
  // no capsule behaves differently for having a different one.
  const rawWallet = optionalEnv("CAPSULE_WALLET") ?? "8899";
  let walletPort: number | undefined;
  if (rawWallet.toLowerCase() === "off") {
    walletPort = undefined;
  } else {
    walletPort = Number(rawWallet);
    if (!Number.isSafeInteger(walletPort) || walletPort < 1024 || walletPort > 65_535) {
      throw new InvalidEnvError("CAPSULE_WALLET", 'must be a port between 1024 and 65535, or "off"');
    }
  }

  const rawCeiling = optionalEnv("CAPSULE_SPEND_CEILING");
  let spendCeiling: bigint | undefined;
  if (rawCeiling !== undefined) {
    try {
      spendCeiling = parseEther(rawCeiling);
    } catch {
      throw new InvalidEnvError("CAPSULE_SPEND_CEILING", "is not a decimal ETH amount");
    }
    if (spendCeiling < 0n) {
      throw new InvalidEnvError("CAPSULE_SPEND_CEILING", "must not be negative");
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
    walletPort,
    spendCeiling,
  };
}
