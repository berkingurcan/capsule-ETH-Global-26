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
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { namehash, normalize, packetToBytes } from "viem/ens";
import { UNIVERSAL_RESOLVER_V2 } from "./chain.js";

export const universalResolverAbi = parseAbi([
  // The errors matter as much as the function. Without them viem cannot name
  // what went wrong and prints thirty lines of undecoded selector per failed
  // read — and in step 4 a stranger typing a name that does not exist is the
  // single most common thing that will happen to this code.
  "error ResolverNotFound(bytes name)",
  "error ResolverNotContract(bytes name, address resolver)",
  "error DNSDecodingFailed(bytes dns)",
  "error UnsupportedResolverProfile(bytes4 selector)",
  "function resolve(bytes name, bytes data) view returns (bytes, address)",
]);

/** Used to encode the inner request and to decode the reply it comes back in. */
export const resolverAbi = parseAbi([
  // The revert the runner exists to catch. Named here so viem can decode it
  // instead of reporting an undecoded selector — or, if you go through cast,
  // "failed to estimate gas" with no reason at all.
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
  "function text(bytes32 node, string key) view returns (string)",
  "function addr(bytes32 node) view returns (address)",
  "function setText(bytes32 node, string key, string value)",
]);

/**
 * text() with nothing behind it answers with an ABI-encoded empty string, which
 * decodes cleanly to "". A resolver that answers with zero bytes instead would
 * throw in the decoder, so both shapes collapse to the same "not set" here.
 */
export function decodeText(result: Hex): string {
  if (result === "0x") return "";
  return decodeFunctionResult({ abi: resolverAbi, functionName: "text", data: result });
}

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

export type AddrRecord = {
  /** zeroAddress when the name publishes no address. */
  address: Address;
  resolver: Address;
};

/**
 * Reads the `addr` record — who the name says it is.
 *
 * The runner checks this against itself and refuses to boot on a mismatch.
 * The prompt service checks it against a request signature. Same record, two
 * directions: it is the closest thing Capsule has to an identity database, and
 * it is one the protocol already maintains.
 */
export async function readAddr(client: PublicClient, name: string): Promise<AddrRecord> {
  const { node, dnsName } = encodeName(name);

  const data = encodeFunctionData({ abi: resolverAbi, functionName: "addr", args: [node] });

  const [result, resolver] = await client.readContract({
    address: UNIVERSAL_RESOLVER_V2,
    abi: universalResolverAbi,
    functionName: "resolve",
    args: [dnsName, data],
  });

  const address =
    result === "0x"
      ? zeroAddress
      : decodeFunctionResult({ abi: resolverAbi, functionName: "addr", data: result });

  return { address, resolver };
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
  // through untouched.
  return { value: decodeText(result), resolver };
}
