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
import { resolverAbi, universalResolverAbi, UNIVERSAL_RESOLVER_V2 } from "./chain";

export type NameEncoding = { name: string; node: Hex; dnsName: Hex };

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

/** Empty string means the key is unset — not an error. */
export async function readText(
  client: PublicClient,
  name: string,
  key: string,
): Promise<{ value: string; resolver: Address }> {
  const { node, dnsName } = encodeName(name);
  const data = encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [node, key] });

  const [result, resolver] = await client.readContract({
    address: UNIVERSAL_RESOLVER_V2,
    abi: universalResolverAbi,
    functionName: "resolve",
    args: [dnsName, data],
  });

  const value =
    result === "0x"
      ? ""
      : decodeFunctionResult({ abi: resolverAbi, functionName: "text", data: result });

  return { value, resolver };
}
