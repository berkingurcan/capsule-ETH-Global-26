/**
 * The record keys and the EAC derivations, spelled once for the indexer.
 *
 * This is the fourth copy of the key table. The other three are
 * `contracts/src/CapsuleMinter.sol`, `runner/src/records.ts` and
 * `web/lib/capsule/records.ts`, and the reason they are duplicated rather
 * than shared is written up in the runner's copy: each ships independently.
 *
 * The stakes are the same here and worth restating, because a mismatch does
 * not fail loudly. `PermissionedResolver` reverts against the *name-level*
 * resource whichever key was denied, so a subgraph that derived
 * `agent.heartbeat` instead of `agent-heartbeat` would compute a resource id
 * that matches no event, attribute no role change to any capsule, and render
 * a fleet where nothing was ever recalled. It would look like a working
 * subgraph. `web/scripts/check-records.ts` asserts this file against the
 * other three.
 */
import { BigInt, ByteArray, Bytes, crypto } from "@graphprotocol/graph-ts";

export const KEY_CLASS = "class";
export const KEY_SCHEMA = "schema";
export const KEY_CONTEXT = "agent-context";
export const KEY_ENDPOINT_WEB = "agent-endpoint[web]";
export const KEY_ENDPOINT_CAPSULE = "agent-endpoint[capsule]";
export const KEY_MODEL = "agent-model";
export const KEY_RUNTIME = "agent-runtime";
export const KEY_PROMPT = "agent-prompt";
export const KEY_HEARTBEAT = "agent-heartbeat";

/** ENSIP-25's key carries two bracket groups and a tokenId, so it is matched by prefix. */
export const KEY_REGISTRATION_PREFIX = "agent-registration[";

/** `1 << 4` — `PermissionedResolver`'s write-a-text-record role. */
export const ROLE_SET_TEXT = BigInt.fromI32(16);

/** What `RoleChange.resourceKind` says. */
export const KIND_HEARTBEAT = "agent-heartbeat";
export const KIND_NAME = "name";

/**
 * `uint256(keccak256(abi.encode(node, part)))`, as the decimal string an
 * `EACRolesChanged` topic decodes to.
 *
 * `abi.encode` of two `bytes32` is their concatenation, so this is one hash
 * over 64 bytes. The decimal string is the id format because the event gives
 * a `BigInt` and the derivation gives bytes, and a decimal string is the one
 * spelling both reach losslessly — a hex comparison would have to agree about
 * zero padding, which is exactly the kind of detail that fails silently.
 */
function resourceOf(node: Bytes, part: ByteArray): string {
  const buffer = new Uint8Array(64);
  buffer.set(node, 0);
  buffer.set(part, 32);
  const hash = crypto.keccak256(Bytes.fromUint8Array(buffer));
  return bigIntFromBigEndian(hash).toString();
}

/** The resource guarding one text key on one name. */
export function textResourceOf(node: Bytes, key: string): string {
  return resourceOf(node, crypto.keccak256(Bytes.fromUTF8(key)));
}

/**
 * The name-level resource, `resource(node, 0)`.
 *
 * This is what the resolver checks the *caller* against before it will revoke,
 * and what `setText` reverts against whichever key was actually denied.
 */
export function nameResourceOf(node: Bytes): string {
  return resourceOf(node, new ByteArray(32));
}

/**
 * A big-endian 32-byte hash as a `BigInt`.
 *
 * `BigInt.fromUnsignedBytes` reads little-endian, which is the opposite of
 * what keccak hands back and of how Solidity casts a `bytes32` to a
 * `uint256`. Reversing by hand rather than through `ByteArray.reverse()`
 * keeps this independent of which graph-ts version is installed.
 */
export function bigIntFromBigEndian(value: ByteArray): BigInt {
  const reversed = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    reversed[i] = value[value.length - 1 - i];
  }
  return BigInt.fromUnsignedBytes(Bytes.fromUint8Array(reversed));
}

/** `(bitmap & ROLE_SET_TEXT) != 0` — whether an account may write a text record. */
export function holdsSetText(bitmap: BigInt): boolean {
  return bitmap.bitAnd(ROLE_SET_TEXT).notEqual(BigInt.zero());
}

/**
 * `"beat-7"` -> 7, `""` -> 0.
 *
 * Deliberately tolerant, and for the same reason the runner's copy is: a
 * capsule must not vanish from the dashboard because some earlier version of
 * itself, or a curious owner, wrote a value this parser did not expect.
 */
export function parseHeartbeatSequence(raw: string): BigInt {
  let end = raw.length;
  while (end > 0 && isSpace(raw.charCodeAt(end - 1))) end--;
  let start = end;
  while (start > 0 && isDigit(raw.charCodeAt(start - 1))) start--;
  if (start === end) return BigInt.zero();
  return BigInt.fromString(raw.substring(start, end));
}

function isDigit(code: i32): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isSpace(code: i32): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * DNS wire format -> a name a human can read.
 *
 * `0x0c63617073756c65666c6565740365746800` -> `capsulefleet.eth`.
 *
 * The minter stores the parent this way and `ParentConnected` does not carry
 * it, which is why the connect handler pays for one `parentOf` call. Without
 * the name, every capsule in this index would be a label with no idea what it
 * hangs off — and the whole point of the analyst reading it is that it can
 * answer in names.
 */
export function decodeDnsName(dns: Bytes): string {
  let out = "";
  let offset = 0;
  while (offset < dns.length) {
    const length = dns[offset];
    if (length === 0) break;
    offset += 1;
    if (offset + length > dns.length) return out;
    if (out.length > 0) out += ".";
    out += Bytes.fromUint8Array(dns.subarray(offset, offset + length)).toString();
    offset += length;
  }
  return out;
}

/** `tx ++ logIndex` — the id every immutable event entity is keyed by. */
export function eventId(tx: Bytes, logIndex: BigInt): Bytes {
  return tx.concatI32(logIndex.toI32());
}
