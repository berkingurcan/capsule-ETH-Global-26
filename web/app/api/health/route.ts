/**
 * GET /api/health — can this deployment reach the things it depends on?
 *
 * Exists because a dependency that works from a laptop and fails from the
 * platform is the most expensive class of bug in this system: it looks like a
 * code failure, it only reproduces in production, and the first time we met it
 * was a public RPC endpoint that answers laptops and refuses datacenters.
 *
 * Deliberately unauthenticated. It reports reachability, never values, and
 * every detail string is passed through a redactor before it leaves — error
 * messages from RPC and database clients routinely quote the connection URL
 * they failed on, credentials included.
 */
import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { zeroAddress } from "viem";
import { ETH_REGISTRY, createServerClient, minterAbi, registryAbi } from "@/lib/capsule/chain";
import { encodeParent } from "@/lib/capsule/parent";
import { loadServerEnv } from "@/lib/capsule/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Strips any scheme://... token. Connection strings carry passwords. */
function redact(message: string): string {
  return message.replace(/\w+:\/\/\S+/g, "[url]").split("\n")[0]!.slice(0, 200);
}

type Probe = { name: string; ok: boolean; ms: number; detail: string };

async function probe(name: string, fn: () => Promise<string>): Promise<Probe> {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: Date.now() - started, detail };
  } catch (error) {
    return {
      name,
      ok: false,
      ms: Date.now() - started,
      detail: redact(error instanceof Error ? error.message : String(error)),
    };
  }
}

export async function GET(): Promise<NextResponse> {
  let env;
  try {
    env = loadServerEnv();
  } catch (error) {
    // Names the missing variable and nothing else. Which variable is unset is
    // not a secret; its value is, and this never touches it.
    return NextResponse.json(
      { ok: false, checks: [{ name: "env", ok: false, ms: 0, detail: redact(String(error)) }] },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const checks = await Promise.all([
    probe("rpc", async () => {
      const block = await createServerClient(env.rpcUrl).getBlockNumber();
      return `sepolia block ${block}`;
    }),
    probe("minter", async () => {
      // The check that matters most operationally: if the minter has lost its
      // resolver roles, every mint reverts after the user has already paid.
      //
      // Scoped to the DEFAULT parent, which is the honest scope for a health
      // check now that one minter serves many names. A green light here says the
      // demo's front door works; it says nothing about a name someone connected
      // an hour ago, and it should not, because that name's owner can revoke the
      // minter's roles at will and their doing so is not this deployment being
      // unhealthy. Per-parent readiness is what /connect and the launch form read.
      const client = createServerClient(env.rpcUrl);
      const parent = encodeParent(env.defaultParentName);
      const registry = await client.readContract({
        address: ETH_REGISTRY,
        abi: registryAbi,
        functionName: "getSubregistry",
        args: [parent.label],
      });
      if (registry === zeroAddress) return `${parent.name} has no subregistry`;

      const [connected, registrarGranted, resolverRolesGranted] = await client.readContract({
        address: env.minterAddress,
        abi: minterAbi,
        functionName: "readiness",
        args: [registry, env.minterAddress],
      });
      if (!connected) throw new Error(`${parent.name} is not connected to the minter`);
      if (!registrarGranted) throw new Error(`the minter lacks ROLE_REGISTRAR on ${parent.name}`);
      if (!resolverRolesGranted) throw new Error(`the minter lacks resolver roles on ${parent.name}`);
      return `connected, roles held on ${parent.name}`;
    }),
    probe("database", async () => {
      const rows = (await neon(env.databaseUrl)`select 1 as ok`) as { ok: number }[];
      return rows[0]?.ok === 1 ? "reachable" : "unexpected reply";
    }),
  ]);

  const ok = checks.every((c) => c.ok);

  return NextResponse.json(
    { ok, endpoint: `${env.publicUrl}/api`, parent: env.defaultParentName, checks },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
