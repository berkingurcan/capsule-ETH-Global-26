/**
 * Hearing the "no".
 *
 * A heartbeat can fail for many reasons and exactly one of them means the agent
 * was revoked. Read that wrong in either direction and the whole thesis goes
 * with it: too loose and the agent dies of a flaky RPC on camera, too strict
 * and the owner presses Recall and the bot keeps talking.
 *
 * So: only EACUnauthorizedAccountRoles counts, everything unrecognised is
 * assumed transient, and before halting the runner confirms the revocation
 * against the role table rather than trusting the revert — which, per the
 * resolver's onlyPartRoles modifier, names the wrong resource on purpose.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  hexToBigInt,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { HEARTBEAT_KEY, type CapsuleConfig } from "./config.js";
import { HeartbeatRevertedError } from "./heartbeat.js";
import { resolverAbi } from "./resolve.js";

/** PermissionedResolverLib: ROLE_SET_TEXT = 1 << 4. The 16 in every revert. */
export const ROLE_SET_TEXT = 16n;

const ZERO_NODE = `0x${"0".repeat(64)}` as Hex;

export type HeartbeatVerdict = "revoked" | "transient";

/**
 * resource = uint256(keccak256(abi.encode(node, part)))
 *
 * `part` is keccak256 of the record key for a per-key resource, and zero for
 * the name-level one. Reproduce from the shell with:
 *   cast keccak $(cast abi-encode 'f(bytes32,bytes32)' $NODE $(cast keccak 'agent.heartbeat'))
 */
export function textResource(node: Hex, key: string): bigint {
  const part = keccak256(toHex(key));
  return hexToBigInt(
    keccak256(
      encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [node, part]),
    ),
  );
}

/**
 * Was this failure a revocation, or just a bad day?
 *
 * Unknown errors are transient by default. An error we cannot identify is not
 * evidence that a permission was taken away.
 */
export function classifyHeartbeatFailure(error: unknown): HeartbeatVerdict {
  // Mined and reverted. Simulation passed, then a revoke landed in between —
  // precisely the race the demo creates when Recall is pressed mid-flight.
  if (error instanceof HeartbeatRevertedError) return "revoked";

  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      return reverted.data?.errorName === "EACUnauthorizedAccountRoles" ? "revoked" : "transient";
    }
  }

  return "transient";
}

export type RoleCheck = {
  /** Granted on this name specifically. What CapsuleMinter hands the agent. */
  perName: boolean;
  /**
   * Granted on `resource(0, part)` — every name this resolver serves. The
   * modifier accepts it, so a confirmation that ignored it could be wrong.
   * Capsule never grants here: one such grant would let every agent write
   * every other agent's heartbeat.
   */
  wildcard: boolean;
};

export async function checkHeartbeatRole(
  client: PublicClient,
  config: CapsuleConfig,
  agent: Address,
): Promise<RoleCheck> {
  const resources = [
    textResource(config.node, HEARTBEAT_KEY),
    textResource(ZERO_NODE, HEARTBEAT_KEY),
  ];

  const [perName, wildcard] = await Promise.all(
    resources.map((resource) =>
      client.readContract({
        address: config.resolver,
        abi: resolverAbi,
        functionName: "hasRoles",
        args: [resource, ROLE_SET_TEXT, agent],
      }),
    ),
  );

  return { perName: perName === true, wildcard: wildcard === true };
}

/**
 * The last check before the runner stops.
 *
 * If the role is somehow still held, this was not a revocation and the runner
 * keeps going — whatever went wrong, it was something else.
 */
export async function confirmRevoked(
  client: PublicClient,
  config: CapsuleConfig,
  agent: Address,
): Promise<{ revoked: boolean; roles: RoleCheck }> {
  const roles = await checkHeartbeatRole(client, config, agent);
  return { revoked: !roles.perName && !roles.wildcard, roles };
}
