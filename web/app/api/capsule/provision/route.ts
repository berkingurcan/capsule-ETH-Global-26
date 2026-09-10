/**
 * POST /api/capsule/provision — turn a minted name into a running agent.
 *
 * The mint creates the name, writes its records and grants the agent its one
 * key. Nothing is running at that point: there is an `addr` record naming an
 * address whose private half is sealed in our store, and no process holding it.
 * This route is what closes that gap. It funds the agent so it can pay for its
 * own heartbeat, and starts a Fly machine holding its key.
 *
 * ## Two questions, and they are not the same question
 *
 * **Is this capsule real?** Answered by the chain: the name's `addr` record must
 * name an agent whose key we hold. That check is what makes the store safe to
 * read — the same rule the prompt and runtime routes follow. Rows are written
 * before the mint, when nobody owns the label, so several people may have
 * proposed an agent for one name; the mint picks the winner by writing its
 * address into `addr`, and this route follows that and no other record of it.
 *
 * **May this caller ask for it?** Not answered by that check, and the difference
 * matters because this route spends money. `addr` says a capsule exists; it says
 * nothing about who is asking. A route that provisioned any minted name for
 * anyone would let a stranger drain the funder wallet and fill the Fly app, and
 * minting is permissionless and nearly free — so the attack is: mint a hundred
 * labels, provision a hundred machines, on someone else's ETH.
 *
 * So the caller signs, and the signer must be the name's **current** owner
 * according to `registry.findOwner`. Not the owner in the `CapsuleMinted` log: a
 * transferred name belongs to whoever holds it now, and the log records who held
 * it once. There is still no session and no user table — the authorisation
 * database is the registry, one layer down from the resolver the other routes
 * ask.
 *
 * ## What bounds the cost
 *
 * An owner can still call this repeatedly for their own names, so neither spend
 * is per-request:
 *
 *   - **The machine** is found by metadata before anything else happens. A
 *     capsule that already has a live machine returns 200 and starts nothing.
 *   - **The funding** tops the agent up to a target balance rather than sending
 *     a fixed amount, so the second call sends nothing.
 *
 * Per name, the cost is therefore one machine and one top-up however many times
 * it is called, which is a bound the chain enforces rather than a counter we
 * keep.
 *
 * ## Order
 *
 *   1. headers, body, label shape         free
 *   2. timestamp inside the TTL           free
 *   3. signature recovers                 local ecrecover
 *   4. the registry names an owner        one read
 *   5. the signer IS that owner           free
 *   6. addr + agent-model resolve         one multicall
 *   7. we hold the agent's key            one query
 *   8. is a machine already running?      one Fly call
 *   9. fund the agent                     one transaction
 *  10. create the machine                 one Fly call
 *
 * Steps 9 and 10 are the only ones that cost anything, and everything that can
 * refuse the request runs before them. Funding first is deliberate: a machine
 * that boots against an unfunded agent fails its first heartbeat, and a
 * heartbeat that fails for want of gas is the one thing this system must never
 * let look like a revocation.
 */
import { NextResponse } from "next/server";
import { formatEther, recoverMessageAddress, zeroAddress, type Address, type Hex } from "viem";
import { ETH_REGISTRY, createServerClient, registryAbi } from "@/lib/capsule/chain";
import { loadProvisionerEnv, loadServerEnv, InvalidEnvError, MissingEnvError } from "@/lib/capsule/env";
import { createMachine, findCapsuleMachine, FlyError, type FlyConfig } from "@/lib/capsule/fly";
import { fundAgent, FundingError } from "@/lib/capsule/fund";
import { encodeParent } from "@/lib/capsule/parent";
import { parseModelRef } from "@/lib/capsule/providers";
import {
  machineMetadata,
  machineNameFor,
  parseProvisionRequest,
  runnerEnvironment,
} from "@/lib/capsule/provision";
import { readIdentity } from "@/lib/capsule/resolve";
import { createStore, readAgent, secrets } from "@/lib/capsule/store";
import {
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  isPrepareTimestampFresh,
  isSameAddress,
  provisionMessage,
} from "@/lib/capsule/wire";

/** node:crypto, the AES envelope and a signing key. Not edge-compatible. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Two network writes and four reads. The default 10s is not enough for a Fly
 * machine create on a cold app, and a timeout here is the worst possible
 * outcome: the money may already be spent and the caller is told nothing.
 */
export const maxDuration = 60;

const NO_STORE = { "cache-control": "no-store, no-cache, must-revalidate" };

function fail(status: number, error: string, log: string, extra: object = {}): NextResponse {
  console.warn(`provision deny ${status} — ${log}`);
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
}

export async function POST(request: Request): Promise<NextResponse> {
  // --- 1. shape ------------------------------------------------------------
  const timestampHeader = request.headers.get(HEADER_TIMESTAMP);
  const signature = request.headers.get(HEADER_SIGNATURE);
  if (timestampHeader === null || signature === null) {
    return fail(400, "missing capsule headers", "missing headers");
  }

  const raw = await request.text();
  if (raw.length > 4_000) return fail(413, "request body is too large", `body ${raw.length} bytes`);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "body is not valid JSON", "unparseable body");
  }

  let env;
  let provisioner;
  try {
    env = loadServerEnv();
    provisioner = loadProvisionerEnv();
  } catch (error) {
    // Names the variable, because this one is ours to fix and the caller can do
    // nothing about it. `CAPSULE_FUNDER_KEY` is required by this route alone, so
    // a deployment that only mints reaches every other page without it — and
    // finds out here, once, rather than everywhere.
    if (error instanceof MissingEnvError || error instanceof InvalidEnvError) {
      console.error(`provision 503 — ${error.message}`);
      return NextResponse.json(
        { error: `the provisioner is not configured: ${error.message}` },
        { status: 503, headers: NO_STORE },
      );
    }
    throw error;
  }

  const parsed = parseProvisionRequest(body, env.defaultParentName);
  if (!parsed.ok) {
    return fail(422, "the request has problems", "validation failed", { problems: parsed.problems });
  }
  const { label, parentName, capsuleName } = parsed;

  // --- 2. freshness --------------------------------------------------------
  const timestamp = Number(timestampHeader);
  if (!Number.isSafeInteger(timestamp) || !isPrepareTimestampFresh(timestamp)) {
    return fail(403, "signature expired", `${capsuleName}: stale timestamp ${timestampHeader}`);
  }

  // --- 3. recovery ---------------------------------------------------------
  //
  // The capsule name is inside the signed message and was rebuilt here from the
  // request's own label and parent, so a caller signing against a different name
  // than the one it sent fails this check rather than booting a machine for a
  // name that does not exist. The parent being caller-supplied costs nothing
  // here: whatever it is, it is what got signed, and the ownership check below
  // is what decides whether the signer may act on it.
  let signer: Address;
  try {
    signer = await recoverMessageAddress({
      message: provisionMessage(capsuleName, timestamp),
      signature: signature as Hex,
    });
  } catch {
    return fail(403, "bad signature", `${capsuleName}: signature did not recover`);
  }

  const client = createServerClient(env.rpcUrl);

  // --- 4. who owns it, who it claims, and what it says it runs -------------
  //
  // Sequential, and it has to be. `readIdentity` is EXPECTED to revert for a
  // name nobody has registered — there is no resolver for a name that does not
  // exist — so the registry read has to land on its own first. Running the two
  // together does not work even with `Promise.allSettled`: `createServerClient`
  // batches concurrent reads into one Multicall3 call, so the resolver's revert
  // takes the aggregate down and the registry read rejects with it. The result
  // is "we could not read the chain" — an outage, inviting a retry that will
  // fail identically forever — in place of "this name is not minted", which is
  // a 404 the caller can act on. Costing one extra round trip to say the right
  // thing is the correct trade.
  let owner: Address;
  try {
    // The parent's own subregistry, found from the name rather than from the
    // minter. `minter.REGISTRY()` used to answer this and no longer exists: one
    // minter now serves every connected name, so there is no single registry to
    // ask it about. `getSubregistry` is the general form of the same question and
    // needs no configuration — the chain knows where each name's subnames live.
    const registry = await client.readContract({
      address: ETH_REGISTRY,
      abi: registryAbi,
      functionName: "getSubregistry",
      args: [encodeParent(parentName).label],
    });
    if (registry === zeroAddress) {
      // Not an outage and not an unowned name: the parent has no subregistry, so
      // no capsule under it can exist and this one certainly was not minted.
      return fail(
        404,
        `${parentName} has no subregistry, so ${capsuleName} cannot have been minted`,
        `${capsuleName}: getSubregistry(${parentName}) is the zero address`,
      );
    }
    owner = await client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "findOwner",
      args: [label],
    });
  } catch (error) {
    // We could not perform the check, which is not the same as failing it.
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.error(`provision 502 — could not read the registry for ${capsuleName}: ${detail}`);
    return NextResponse.json(
      { error: "could not read the name on chain" },
      { status: 502, headers: NO_STORE },
    );
  }

  if (owner === zeroAddress) {
    return fail(404, `${capsuleName} is not minted`, `${capsuleName}: findOwner returned the zero address`);
  }
  if (!isSameAddress(signer, owner)) {
    return fail(
      403,
      `${capsuleName} is not owned by the signer`,
      `${capsuleName}: signer ${signer} != owner ${owner}`,
    );
  }

  // Only now, with the caller proved to be the owner, is it worth resolving the
  // records — and a revert here means something different: the name IS
  // registered and its records still do not resolve, which is a name minted by
  // something other than CapsuleMinter, or a resolver that is down.
  let identity;
  try {
    identity = await readIdentity(client, capsuleName);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.error(`provision 502 — ${capsuleName} is registered but does not resolve: ${detail}`);
    return NextResponse.json(
      { error: `${capsuleName} is registered but its records do not resolve` },
      { status: 502, headers: NO_STORE },
    );
  }
  if (identity.address === zeroAddress) {
    // A name minted by something other than CapsuleMinter, or one whose owner
    // has cleared `addr`. Either way there is no agent to start.
    return fail(409, `${capsuleName} has no addr record`, `${capsuleName}: addr is unset`);
  }

  // The runner refuses a malformed `agent-model` at boot and exits — which, from
  // outside, is a machine that was created and then vanished. Every name in the
  // fleet was once unbootable for exactly this reason (GATE-LOG.md), so it is
  // checked here, before anything is spent, where the message can say what to fix.
  const model = parseModelRef(identity.model);
  if (model === null) {
    return fail(
      409,
      `agent-model on ${capsuleName} is "${identity.model}" — the runner needs <provider>/<model>, ` +
        "such as anthropic/claude-opus-5",
      `${capsuleName}: unusable agent-model "${identity.model}"`,
    );
  }

  // --- 5. do we hold this agent's key? -------------------------------------
  //
  // Scoped by the address the chain publishes, never by the name alone. A losing
  // proposal for the same label has rows in the same tables and is addressed by
  // nothing.
  const store = createStore(env);
  let agentRow;
  let providerRow;
  try {
    [agentRow, providerRow] = await Promise.all([
      readAgent(store, { capsuleName, address: identity.address }),
      secrets.readProviderKey(store, {
        capsuleName,
        agentAddress: identity.address,
        provider: model.provider,
      }),
    ]);
  } catch (error) {
    console.error(`provision 500 — ${capsuleName}: ${error instanceof Error ? error.name : "?"}`);
    return NextResponse.json({ error: "internal error" }, { status: 500, headers: NO_STORE });
  }

  if (agentRow === null) {
    return fail(
      409,
      `this deployment does not hold the key for ${identity.address}, the agent ${capsuleName} publishes`,
      `${capsuleName}: no capsule_agent row for ${identity.address}`,
    );
  }

  // A missing provider key does NOT refuse the boot. The runner survives it,
  // says so loudly, and keeps heartbeating — the owner can store a key and
  // restart. Refusing here would turn a fixable configuration gap into a capsule
  // that cannot be started at all.
  const warnings: string[] = [];
  if (providerRow === null) {
    warnings.push(
      `no ${model.provider} key is stored for this agent, so the bot will start and be unable to answer ` +
        `until one is — the capsule stays alive and says so`,
    );
  }

  const fly: FlyConfig = { token: env.flyApiToken, appName: env.flyAppName };

  // --- 6. is one already running? ------------------------------------------
  let existing;
  try {
    existing = await findCapsuleMachine(fly, capsuleName);
  } catch (error) {
    const detail = error instanceof FlyError ? error.message : String(error);
    console.error(`provision 502 — could not list machines: ${detail}`);
    return NextResponse.json({ error: "could not reach Fly" }, { status: 502, headers: NO_STORE });
  }

  if (existing !== null) {
    console.log(`provision 200 — ${capsuleName} already has machine ${existing.id} (${existing.state})`);
    return NextResponse.json(
      {
        capsuleName,
        label,
        owner,
        agent: identity.address,
        model: identity.model,
        created: false,
        machine: {
          id: existing.id,
          name: existing.name,
          state: existing.state,
          region: existing.region,
        },
        funding: null,
        warnings,
      },
      { status: 200, headers: NO_STORE },
    );
  }

  // --- 7. gas ---------------------------------------------------------------
  let funding;
  try {
    funding = await fundAgent({
      rpcUrl: env.rpcUrl,
      funderKey: provisioner.funderKey,
      agent: identity.address,
      target: provisioner.agentFundingWei,
    });
  } catch (error) {
    // The funder being empty is ours to fix and the caller can do nothing about
    // it, so it says so plainly rather than hiding behind "internal error". It
    // names our own funder address, which is public information.
    if (error instanceof FundingError) {
      console.error(`provision 503 — ${error.message}`);
      return NextResponse.json({ error: error.message }, { status: 503, headers: NO_STORE });
    }
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.error(`provision 502 — could not fund ${identity.address}: ${detail}`);
    return NextResponse.json(
      { error: "could not fund the agent — nothing was started" },
      { status: 502, headers: NO_STORE },
    );
  }

  // --- 8. the machine -------------------------------------------------------
  let machine;
  try {
    machine = await createMachine(fly, {
      name: machineNameFor(label),
      region: env.flyRegion,
      image: env.runnerImage,
      env: runnerEnvironment({
        rpcUrl: env.rpcUrl,
        capsuleName,
        agentAddress: identity.address,
        agentPrivateKey: agentRow.privateKey,
        tickSeconds: provisioner.tickSeconds,
        heartbeatSeconds: provisioner.heartbeatSeconds,
      }),
      memoryMb: provisioner.machineMemoryMb,
      metadata: machineMetadata({ capsuleName, agentAddress: identity.address }),
    });
  } catch (error) {
    // The funding already landed and is not recoverable — it is the agent's ETH
    // now, and a retry will find it and send nothing. Say that, rather than
    // letting the caller assume the whole request was a no-op.
    const detail = error instanceof FlyError ? error.message : String(error);
    console.error(`provision 502 — could not create a machine for ${capsuleName}: ${detail}`);
    return NextResponse.json(
      {
        error: "the agent was funded but the machine could not be started — retrying is safe and will not re-fund",
        detail: error instanceof FlyError ? `fly returned ${error.status}` : "fly was unreachable",
        funding: {
          sent: funding.sent.toString(),
          hash: funding.hash,
        },
      },
      { status: 502, headers: NO_STORE },
    );
  }

  console.log(
    `provision 200 — ${capsuleName} · machine ${machine.id} (${machine.state}) · agent ${identity.address} · ` +
      (funding.sent === 0n
        ? `already held ${formatEther(funding.balanceBefore)} ETH`
        : `funded ${formatEther(funding.sent)} ETH ${funding.hash}`),
  );

  return NextResponse.json(
    {
      capsuleName,
      label,
      owner,
      agent: identity.address,
      model: identity.model,
      created: true,
      machine: {
        id: machine.id,
        name: machine.name,
        state: machine.state,
        region: machine.region,
      },
      // Wei as strings: JSON has no integers this large, and rounding an agent's
      // gas budget through a double is the kind of bug that shows up as a
      // heartbeat that stops three weeks later.
      funding: {
        balanceBefore: funding.balanceBefore.toString(),
        target: provisioner.agentFundingWei.toString(),
        sent: funding.sent.toString(),
        hash: funding.hash,
      },
      warnings,
    },
    { status: 200, headers: NO_STORE },
  );
}
