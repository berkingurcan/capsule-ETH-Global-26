/**
 * Reading a capsule's records, server side.
 *
 * A trimmed port of runner/src/resolve.ts — the same two encodings and the
 * same UniversalResolverV2 indirection, minus the write path the server does
 * not have. Unlike the prompt wire contract, drift here is loud rather than
 * silent: get the encoding wrong and every resolve fails immediately with a
 * named error, so this copy is not guarded by a script.
 *
 * `readAddr` is the authorisation primitive for the whole backend. There is no
 * user table anywhere in Capsule; the question "may this signer act as this
 * name" is answered by an ENS record that the name's owner controls.
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { namehash, normalize, packetToBytes } from "viem/ens";
import { ACTIVE, DEPLOYMENTS, resolverAbi, universalResolverAbi } from "./chain";
import { RECORD_KEYS } from "./records";

export type NameEncoding = { name: string; node: Hex; dnsName: Hex };

/**
 * The UniversalResolvers to try, active deployment first.
 *
 * Two ENSv2 deployments are live on Sepolia and a capsule may sit under a name
 * on either — one registered through the ENS hackathon portal, one through the
 * beta. Each deployment's UniversalResolver knows only its own names and answers
 * `ResolverNotFound` for the other's, so a single hardcoded address makes half
 * the fleet invisible.
 *
 * Ordered rather than raced: the active deployment answers for almost every
 * name, so the second entry is a fallback that normally costs nothing. Reads go
 * through ENSIP-10 `resolve()` either way, which is the one calling convention
 * both revisions share — the hackathon resolver has no `text(bytes32,string)` to
 * call directly.
 */
const UNIVERSAL_RESOLVERS = [
  ACTIVE.universalResolver,
  ...Object.values(DEPLOYMENTS)
    .filter((d) => d.id !== ACTIVE.id)
    .map((d) => d.universalResolver),
];

/**
 * `resolve()` against whichever deployment knows the name.
 *
 * A name absent from a deployment reverts (`ResolverNotFound`), so a revert is
 * not necessarily an error — it is how "ask the other one" is spelled. Only when
 * every deployment has refused is the failure real, and then the first
 * deployment's error is the one rethrown, because that is the one the caller
 * expected to work.
 */
async function resolveAnywhere(
  client: PublicClient,
  dnsName: Hex,
  data: Hex,
): Promise<readonly [Hex, Address]> {
  let first: unknown;
  for (const address of UNIVERSAL_RESOLVERS) {
    try {
      return await client.readContract({
        address,
        abi: universalResolverAbi,
        functionName: "resolve",
        args: [dnsName, data],
      });
    } catch (error) {
      first ??= error;
    }
  }
  throw first;
}

/**
 * Normalisation is not cosmetic here. These names arrive from strangers over
 * HTTP, and "Analyst.capsulefleet.eth" must hash to the same node as the
 * lowercase form or the signature check compares the wrong record.
 */
export function encodeName(name: string): NameEncoding {
  const normalized = normalize(name);
  return {
    name: normalized,
    node: namehash(normalized),
    dnsName: toHex(packetToBytes(normalized)),
  };
}

export type AddrRecord = { address: Address; resolver: Address };

export async function readAddr(client: PublicClient, name: string): Promise<AddrRecord> {
  const { node, dnsName } = encodeName(name);
  const data = encodeFunctionData({ abi: resolverAbi, functionName: "addr", args: [node] });

  const [result, resolver] = await resolveAnywhere(client, dnsName, data);

  const address =
    result === "0x"
      ? zeroAddress
      : decodeFunctionResult({ abi: resolverAbi, functionName: "addr", data: result });

  return { address, resolver };
}

/** Empty string means the key is unset — not an error. */
export async function readText(
  client: PublicClient,
  name: string,
  key: string,
): Promise<{ value: string; resolver: Address }> {
  const { node, dnsName } = encodeName(name);
  const data = encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [node, key] });

  const [result, resolver] = await resolveAnywhere(client, dnsName, data);

  const value =
    result === "0x"
      ? ""
      : decodeFunctionResult({ abi: resolverAbi, functionName: "text", data: result });

  return { value, resolver };
}

/**
 * `addr` and `agent-model`, in one round trip.
 *
 * The runtime route needs both and needs them to describe the same instant: it
 * authorises against `addr` and then decides which provider credential to hand
 * over based on `agent-model`. Two separate reads could straddle a `setText`
 * and answer for two different configurations of the same name — which would
 * mean handing a runner the key for a model its record no longer names.
 *
 * `allowFailure: false` because both records are required for the decision.
 * There is no useful half-answer here, and the caller already distinguishes "we
 * could not perform the check" from "the check failed".
 */
export async function readIdentity(
  client: PublicClient,
  name: string,
): Promise<{ address: Address; model: string; resolver: Address }> {
  const { node, dnsName } = encodeName(name);

  const calls = [
    encodeFunctionData({ abi: resolverAbi, functionName: "addr", args: [node] }),
    encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [node, RECORD_KEYS.model] }),
  ];

  /* Sequential across the two calls rather than a multicall, because the
     deployment a name lives on is discovered by trying: a multicall pinned to
     one UniversalResolver cannot fall back per call. Both still describe the
     same instant for the purpose this serves — they are two reads of a record
     pair that only the name's owner can change, not a race against a writer. */
  const [[addrData, addrResolver], [modelData]] = await Promise.all([
    resolveAnywhere(client, dnsName, calls[0]),
    resolveAnywhere(client, dnsName, calls[1]),
  ]);

  const address =
    addrData === "0x"
      ? zeroAddress
      : decodeFunctionResult({ abi: resolverAbi, functionName: "addr", data: addrData });

  const model =
    modelData === "0x"
      ? ""
      : decodeFunctionResult({ abi: resolverAbi, functionName: "text", data: modelData });

  return { address, model, resolver: addrResolver };
}
