/**
 * The envelope. AES-256-GCM, one master key, additional authenticated data
 * bound to the row that holds it.
 *
 * Why AAD matters here and not just "we encrypted it": encryption alone stops
 * someone reading the database. It does not stop someone with write access
 * MOVING a ciphertext. Prompt refs are public — they are published in an ENS
 * text record — so an attacker who can update a row could repoint a victim's
 * ref at their own capsule, boot an agent under a name they control, and have
 * the prompt service hand them the plaintext through the front door.
 *
 * Binding "capsule_prompt:<ref>:<capsule_name>" into the tag closes that. The
 * ciphertext only opens under the identity it was sealed for; change either
 * field in SQL and decryption fails as a forgery, which is what it is.
 *
 * The format is self-describing so a key rotation is a format change, not an
 * archaeology project:
 *
 *     v1.<iv>.<tag>.<ciphertext>      // all base64url
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
/** 96 bits — the size GCM is specified for. Longer IVs get rehashed. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Every failure to open is one error with one message.
 *
 * Wrong key, tampered ciphertext, and wrong AAD are indistinguishable to a
 * caller on purpose: telling them apart tells an attacker which half of their
 * guess was right.
 */
export class SealedDataError extends Error {
  constructor(message = "sealed value could not be opened") {
    super(message);
    this.name = "SealedDataError";
  }
}

const b64 = (b: Buffer): string => b.toString("base64url");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64url");

export function seal(key: Buffer, plaintext: string, aad: string): string {
  if (key.length !== 32) throw new SealedDataError("master key must be 32 bytes");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, b64(iv), b64(tag), b64(ciphertext)].join(".");
}

export function open(key: Buffer, envelope: string, aad: string): string {
  if (key.length !== 32) throw new SealedDataError("master key must be 32 bytes");

  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SealedDataError("sealed value is not a v1 envelope");
  }

  const iv = unb64(parts[1]!);
  const tag = unb64(parts[2]!);
  const ciphertext = unb64(parts[3]!);

  // Check the shapes before handing them to OpenSSL, which reports a length
  // problem differently from an authentication problem and would leak the
  // distinction the error type above is trying to hide.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SealedDataError("sealed value is malformed");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // decipher.final() throws when the tag does not verify. Every reason lands
    // here, which is the intent.
    throw new SealedDataError();
  }
}

/** AAD builders. Centralised so the two sides can never disagree on the string. */
export const aad = {
  prompt: (ref: string, capsuleName: string) => `capsule_prompt:${ref}:${capsuleName}`,
  agent: (capsuleName: string, agentAddress: string) =>
    `capsule_agent:${capsuleName}:${agentAddress.toLowerCase()}`,
  // Binds a credential to the capsule, the agent it was stored for, and the
  // slot. Moving a sealed provider key to another capsule, to another agent's
  // proposal for the same capsule, or to another provider's row on the same
  // agent, produces a row that will not open.
  //
  // The agent address is in here because rows are written before the mint, when
  // nobody owns the name yet — see db/migrations/003. Without it, a second
  // prepare for the same label could hand its own bot token to somebody else's
  // agent, and the envelope would happily decrypt.
  secret: (capsuleName: string, agentAddress: string, slot: string) =>
    `capsule_secret:${capsuleName}:${agentAddress.toLowerCase()}:${slot}`,
};

/** Constant-time compare, for anywhere a secret is checked against user input. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
