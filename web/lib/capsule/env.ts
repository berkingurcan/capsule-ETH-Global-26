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
import { getAddress, type Address } from "viem";

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
  /** e.g. "capsulefleet.eth" — every capsule is a label under this. */
  parentName: string;
  /**
   * The origin written into `agent.endpoint` at mint time, and therefore the
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

  const parentName = requireEnv("CAPSULE_PARENT_NAME");
  if (!parentName.endsWith(".eth") || parentName.split(".").length !== 2) {
    throw new InvalidEnvError(
      "CAPSULE_PARENT_NAME",
      "must be a second-level name such as capsulefleet.eth",
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
    parentName,
    publicUrl: requireUrl("CAPSULE_PUBLIC_URL").replace(/\/+$/, ""),
  };
}
