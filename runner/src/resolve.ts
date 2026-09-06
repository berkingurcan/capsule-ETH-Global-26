/**
 * Reading an agent's own name.
 *
 * The runner is given one thing — its ENS name — and finds out what it is from
 * the records under that name. Every read goes through UniversalResolverV2
 * rather than straight to a resolver, because the resolver address is not
 * knowable in advance: it is per owner, deployed by VerifiableFactory, and
 * resolve() hands it back as the second half of its return.
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { namehash, normalize, packetToBytes } from "viem/ens";
import { UNIVERSAL_RESOLVER_V2 } from "./chain.js";

const universalResolverAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes, address)",
]);

/** Used to encode the inner request and to decode the reply it comes back in. */
const resolverAbi = parseAbi([
  "function text(bytes32 node, string key) view returns (string)",
]);

export type NameEncoding = {
  /** ENSIP-15 normalized. */
  name: string;
  /** namehash — what `text()` and `setText()` take. */
  node: Hex;
  /** DNS wire format — what UniversalResolverV2 takes. */
  dnsName: Hex;
};

/**
 * One name, two encodings, both needed by the same call.
 *
 *   dnsName  07 "analyst" 0c "capsulefleet" 03 "eth" 00   <- resolve()'s `name`
 *   node     keccak chain over the labels, right to left  <- text()'s `node`
 *
 * Crossing them yields ResolverNotFound, which reads like the name does not
 * exist. It does; the bytes were just the wrong shape.
 */
export function encodeName(name: string): NameEncoding {
  // Normalize before hashing: in step 4 these names come from strangers.
  const normalized = normalize(name);
  return {
    name: normalized,
    node: namehash(normalized),
    dnsName: toHex(packetToBytes(normalized)),
  };
}

export type TextRecord = {
  /** Empty string when the key is not set. Not an error — see below. */
  value: string;
  /** Where the answer came from. Task 5 writes here. */
  resolver: Address;
};

/**
 * Reads one text record, and reports which resolver answered.
 *
 * An unset key is not a failure: it returns "". The runner has to be able to
 * tell "this agent has no endpoint configured" (a config problem, fixable by
 * the owner) from "the chain is unreachable" (an infrastructure problem) from
 * "my permission was revoked" (the one it is supposed to die of). Collapsing
 * those into one thrown error is how a revoked agent gets misdiagnosed.
 */
export async function readText(
  client: PublicClient,
  name: string,
  key: string,
): Promise<TextRecord> {
  const { node, dnsName } = encodeName(name);

  const data = encodeFunctionData({
    abi: resolverAbi,
    functionName: "text",
    args: [node, key],
  });

  const [result, resolver] = await client.readContract({
    address: UNIVERSAL_RESOLVER_V2,
    abi: universalResolverAbi,
    functionName: "resolve",
    args: [dnsName, data],
  });

  // `result` is text()'s return value, still ABI-encoded — resolve() passes it
  // through untouched. A resolver with nothing to say may answer with zero
  // bytes rather than an encoded empty string; decoding that would throw.
  if (result === "0x") return { value: "", resolver };

  const value = decodeFunctionResult({
    abi: resolverAbi,
    functionName: "text",
    data: result,
  });

  return { value, resolver };
}
