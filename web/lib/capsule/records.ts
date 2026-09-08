/**
 * The record keys, server and UI side.
 *
 * CANONICAL SOURCE: runner/src/records.ts
 *
 * A deliberate copy, like wire.ts and for the same reason: the runner ships as a
 * standalone container whose Dockerfile installs only runner/package.json, so a shared
 * workspace package would break an image that already works.
 *
 * Drift here is silent and expensive. The resolver derives a per-key resource from the
 * key string, but reverts against the NAME-level resource whichever key was denied, so a
 * dashboard reading `agent-model` from a name minted with `agent.model` shows an empty
 * record, and a runner writing a key the mint did not authorise looks exactly like a
 * revoked agent. `npm run check:wire` re-derives every literal below from the runner
 * source and fails if they have moved apart.
 *
 * The names are not ours: ENSIP-27 requires kebab-case for schema attributes and reserves
 * `class` and `schema`; ENSIP-26 defines `agent-context` and `agent-endpoint[<protocol>]`.
 */

export const KEY_CLASS = "class";
export const KEY_SCHEMA = "schema";
export const KEY_CONTEXT = "agent-context";

export function endpointKey(protocol: string): string {
  return `agent-endpoint[${protocol}]`;
}

export const KEY_ENDPOINT_CAPSULE = endpointKey("capsule");
export const KEY_ENDPOINT_WEB = endpointKey("web");

export const KEY_MODEL = "agent-model";
export const KEY_RUNTIME = "agent-runtime";
export const KEY_PROMPT = "agent-prompt";
export const KEY_HEARTBEAT = "agent-heartbeat";

export const CLASS_AGENT = "Agent";
export const RUNTIME_OPENCLAW = "openclaw";

/** The ENSIP-27 schema this deployment publishes, relative to the control plane origin. */
export const SCHEMA_PATH = "/schema/capsule-agent-v1.json";

/**
 * Who may write each key, as the dashboard states it.
 *
 * This is not the dashboard's opinion. `CapsuleMinter.mint()` grants the owner name-wide
 * resolver roles and grants the agent `ROLE_SET_TEXT` on exactly one key, so the table
 * below is a readout of the EAC grants — which is why the fleet UI can assert it rather
 * than hedge.
 */
export const WRITER: Record<string, "owner" | "agent"> = {
  [KEY_CLASS]: "owner",
  [KEY_SCHEMA]: "owner",
  [KEY_CONTEXT]: "owner",
  [KEY_ENDPOINT_CAPSULE]: "owner",
  [KEY_ENDPOINT_WEB]: "owner",
  [KEY_MODEL]: "owner",
  [KEY_RUNTIME]: "owner",
  [KEY_PROMPT]: "owner",
  [KEY_HEARTBEAT]: "agent",
};

/** ENSIP-25 `agent-registration[<registry>][<agentId>]`, for verifying a capsule. */
export function registrationKey(registryErc7930: string, agentId: string | number | bigint): string {
  return `agent-registration[${registryErc7930}][${agentId}]`;
}

/**
 * `account` on `chainId` as an ERC-7930 interoperable address — the `<registry>` half of
 * the key above. Mirrors AgentRecords.erc7930Address in Solidity; the contract derives its
 * own at construction and exposes it as `REGISTRY_ADDRESS_7930`, which is the value to
 * prefer when one is available. This exists for verifying a name against a minter whose
 * address is all we have.
 */
export function erc7930Address(chainId: number, account: string): string {
  let hex = chainId.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const reference = hex === "00" ? "00" : hex;
  const address = account.toLowerCase().replace(/^0x/, "");
  const refLength = (reference.length / 2).toString(16).padStart(2, "0");
  return `0x0001` + `0000` + refLength + reference + "14" + address;
}
