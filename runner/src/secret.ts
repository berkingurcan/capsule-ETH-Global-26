/**
 * Values that must never reach stdout.
 *
 * The runner's logs go to Fly's log stream, and the fleet dashboard in build
 * step 5 renders that stream to anyone watching. A prompt body that lands in a
 * log line is disclosed, and "remember not to log it" is not a control that
 * survives 2am.
 *
 * So make it structural: printing a Secret prints "[redacted]" through every
 * path Node uses — console.log, string interpolation, JSON.stringify, and
 * util.inspect, which is the one that ignores toString() and catches people
 * out. Reading the real value takes an explicit .value, which greps cleanly in
 * review.
 */
import { createHash } from "node:crypto";

const REDACTED = "[redacted]";

export class Secret<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  get value(): T {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  // console.log() goes through util.inspect, which does not consult toString().
  // Without this a Secret prints as `Secret {}` at best and its contents at worst.
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return "Secret";
  }
}

export type SecretShape = {
  /** Characters. Enough to see that the value changed. */
  length: number;
  /** sha256 prefix. Identifies a value across restarts; discloses nothing. */
  digest: string;
};

/** The only thing about a secret that is safe to log. */
export function describeSecret(secret: Secret<string>): SecretShape {
  const value = secret.value;
  return {
    length: value.length,
    digest: `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`,
  };
}
