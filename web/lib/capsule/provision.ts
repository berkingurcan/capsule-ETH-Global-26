/**
 * What a provision request may contain, and what a runner is handed when one
 * succeeds.
 *
 * Kept out of the route for the same reason `prepare.ts` is: everything here is
 * a pure function of its arguments, so the machine a capsule would get can be
 * asserted without a Fly token, a funded wallet or an HTTP server. The route is
 * then the order of the checks and the two things that actually spend money.
 *
 * The interesting content is `runnerEnvironment`. The runner has no config file
 * — `runner/src/env.ts` reads the environment and nothing else — so this object
 * IS the deployment. Every key it names is required over there, and a key
 * misspelled here produces a container that exits on its first line with
 * "SEPOLIA_RPC_URL is not set", which is at least loud. A key *omitted* here
 * that the runner defaults is worse, so the two that have defaults are set
 * explicitly and the rest are required on both sides.
 */
import type { Address, Hex } from "viem";
import { MACHINE_CAPSULE_NAME } from "./fly";
import { parentNameProblems } from "./parent";
import { labelProblems } from "./prepare";

export type ProvisionProblem = { field: string; message: string };

export function parseProvisionRequest(
  body: unknown,
  defaultParentName: string,
):
  | { ok: true; label: string; parentName: string; capsuleName: string }
  | { ok: false; problems: ProvisionProblem[] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, problems: [{ field: "body", message: "expected a JSON object" }] };
  }

  const fields = body as Record<string, unknown>;
  const raw = fields.label;
  const label = typeof raw === "string" ? raw.trim() : "";

  // Which name this capsule sits under. Optional and defaulted, like the prepare
  // route's, and safe for the same reason: the full capsule name built from it is
  // inside the message the owner signed, so a parent altered in transit fails
  // signature recovery rather than booting a machine for the wrong name.
  const rawParent = fields.parent;
  const parentName = (typeof rawParent === "string" && rawParent.trim() !== ""
    ? rawParent.trim()
    : defaultParentName
  ).toLowerCase();

  // The same rules the prepare route validated the label under, so a name that
  // could be minted can always be provisioned. Re-validated rather than trusted
  // because this route reads it out of a request body, and it goes on to build
  // a machine name and an ENS name out of it.
  const problems = labelProblems(label).map((message) => ({ field: "label", message }));
  for (const message of parentNameProblems(parentName)) problems.push({ field: "parent", message });
  if (problems.length > 0) return { ok: false, problems };

  return { ok: true, label, parentName, capsuleName: `${label}.${parentName}`.toLowerCase() };
}

/**
 * The machine's display name.
 *
 * Cosmetic. Fly does not enforce unique machine names within an app, so this
 * cannot be the identity of a capsule's runner — `MACHINE_CAPSULE_NAME` in the
 * metadata is, and `findCapsuleMachine` reads that. This exists so `fly machine
 * list` is readable by a human during a demo.
 *
 * Truncated to Fly's 63-character limit. A label can itself be 63 characters,
 * which is a name nobody will ever type and which would otherwise be rejected
 * by the API for a reason that has nothing to do with the capsule.
 */
export function machineNameFor(label: string): string {
  return `capsule-${label}`.slice(0, 63);
}

export type RunnerEnvironmentArgs = {
  rpcUrl: string;
  capsuleName: string;
  agentAddress: Address;
  agentPrivateKey: Hex;
  tickSeconds: number;
  heartbeatSeconds: number;
};

/**
 * The runner's entire configuration.
 *
 * `CAPSULE_ENDPOINT_OVERRIDE` is deliberately absent. It is the development
 * escape hatch that points a runner at a local prompt service; a deployed
 * capsule must read `agent-endpoint[capsule]` off its own name, because that
 * record being the source of truth is the claim this project makes. Setting it
 * here would mean a machine that keeps working after the record changes, which
 * is exactly the thing we say cannot happen.
 *
 * The agent's private key travels in this object and lives in the machine's
 * config, which anyone holding `FLY_API_TOKEN` can read. That is the same trust
 * boundary as the container itself — a key the runner must hold to sign its own
 * heartbeat cannot also be hidden from the host running it. It is the least
 * privileged key in the system for exactly this reason: it can write one text
 * record on one name, and the owner can take that away in one transaction.
 */
export function runnerEnvironment(args: RunnerEnvironmentArgs): Record<string, string> {
  return {
    SEPOLIA_RPC_URL: args.rpcUrl,
    CAPSULE_NAME: args.capsuleName,
    AGENT_ADDRESS: args.agentAddress,
    AGENT_KEY: args.agentPrivateKey,
    TICK_SECONDS: String(args.tickSeconds),
    HEARTBEAT_SECONDS: String(args.heartbeatSeconds),
  };
}

/**
 * What the machine says about itself.
 *
 * `capsule_name` is the identity `findCapsuleMachine` matches on. The other two
 * are for whoever is reading `fly machine list` at 3am: the agent address ties
 * the machine to the `addr` record that authorised it, and the timestamp says
 * when — neither is read back by any code here.
 */
export function machineMetadata(args: {
  capsuleName: string;
  agentAddress: Address;
}): Record<string, string> {
  return {
    // Computed, not spelled: this key is what findCapsuleMachine matches on, and
    // a literal here that drifted from the one there would make every provision
    // look like a first provision.
    [MACHINE_CAPSULE_NAME]: args.capsuleName.toLowerCase(),
    capsule_agent: args.agentAddress.toLowerCase(),
    capsule_provisioned_at: new Date().toISOString(),
  };
}
