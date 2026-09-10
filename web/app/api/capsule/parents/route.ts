/**
 * GET /api/capsule/parents?owner=0x… — which names does this wallet have?
 *
 * Exists so a bare /fleet can route someone to their own agents instead of to
 * `CAPSULE_PARENT_NAME`, which is a deployment default and not an identity. The
 * browser knows the connected address; only the server has the RPC key; so the
 * question has to cross the wire, and this is the crossing.
 *
 * Deliberately unauthenticated, and it does not need to be otherwise: every
 * value it returns is already public on ETH Sepolia, and the address is supplied
 * by the caller rather than proven, so there is nothing here that reading a
 * stranger's address would leak that an explorer would not. Note the asymmetry
 * with `/api/prompt/[ref]`, which authorises hard — that route hands back a
 * stored prompt, which is not public. This one only rearranges public facts.
 *
 * What it does spend is the deployment's RPC quota, three round trips at a time,
 * on behalf of anyone who can construct a query string. For a hackathon that is
 * a fair trade; anything longer-lived wants a cache keyed by address and a rate
 * limit, because the failure mode is a bill rather than a breach.
 */
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { loadOwnerParents } from "@/lib/capsule/fleet-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const owner = new URL(request.url).searchParams.get("owner");

  // Checked before it reaches a chain client, which would otherwise turn a typo
  // into an RPC round trip and a 500.
  if (owner === null || !isAddress(owner)) {
    return NextResponse.json({ error: "owner must be an EVM address" }, { status: 400 });
  }

  const result = await loadOwnerParents(owner);
  if (!result.ok) {
    // 503 rather than 500: every failure in here is the RPC being unreachable or
    // a missing variable, which is the deployment being unwell rather than the
    // request being wrong. The caller renders the default fleet either way.
    return NextResponse.json({ error: result.error }, { status: 503 });
  }

  return NextResponse.json({
    parents: result.parents.map((parent) => ({
      name: parent.name,
      open: parent.open,
      minted: parent.minted,
      connectedByOwner: parent.connectedByOwner,
    })),
  });
}
