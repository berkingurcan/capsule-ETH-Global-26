/**
 * The browser half of POST /api/capsule/provision.
 *
 * Client-safe: no env, no node:crypto, no chain client. It exists for the same
 * reason `prepare-client.ts` does — the exact bytes the route verifies are
 * produced in one place, and `scripts/check-provision.ts` signs with this module
 * rather than rolling its own, so the check proves the launchpad will work and
 * not merely that the check does.
 */
import type { Address } from "viem";
import { HEADER_SIGNATURE, HEADER_TIMESTAMP, provisionMessage } from "./wire";
import type { SignMessage } from "./prepare-client";

/** What the route reports back. Wei are strings — see the route. */
export type ProvisionResult = {
  capsuleName: string;
  label: string;
  owner: Address;
  agent: Address;
  model: string;
  /** False when a machine was already running, in which case nothing was spent. */
  created: boolean;
  machine: { id: string; name: string; state: string; region: string };
  funding: { balanceBefore: string; target: string; sent: string; hash: string | null } | null;
  /** Things worth saying out loud that are not reasons to refuse. */
  warnings: string[];
};

export type ProvisionFailure = {
  status: number;
  error: string;
  problems?: { field: string; message: string }[];
  /** Present when the agent was funded but the machine was not created. */
  funding?: { sent: string; hash: string | null };
};

export class ProvisionError extends Error {
  readonly failure: ProvisionFailure;
  constructor(failure: ProvisionFailure) {
    super(failure.error);
    this.name = "ProvisionError";
    this.failure = failure;
  }
}

export async function provisionCapsuleRequest(
  input: { label: string; capsuleName: string; parent?: string },
  signMessage: SignMessage,
  options: { baseUrl?: string } = {},
): Promise<ProvisionResult> {
  const label = input.label.trim().toLowerCase();
  const timestamp = Math.floor(Date.now() / 1000);

  // The capsule name is signed; the label and the parent are sent, and the route
  // rebuilds the name from those two and compares. So the parent travelling in
  // the body is not a way to redirect a provision: change it in flight and the
  // rebuilt name no longer matches the signed one, and recovery fails. What the
  // signature cannot establish is ownership, and the route does not ask it to —
  // it reads `findOwner` on the parent's own registry.
  const signature = await signMessage({
    message: provisionMessage(input.capsuleName, timestamp),
  });

  const response = await fetch(`${options.baseUrl ?? ""}/api/capsule/provision`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HEADER_TIMESTAMP]: String(timestamp),
      [HEADER_SIGNATURE]: signature,
    },
    body: JSON.stringify(input.parent === undefined ? { label } : { label, parent: input.parent }),
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    throw new ProvisionError({
      status: response.status,
      error: typeof body.error === "string" ? body.error : `provision failed (${response.status})`,
      problems: Array.isArray(body.problems)
        ? (body.problems as { field: string; message: string }[])
        : undefined,
      funding: (body.funding ?? undefined) as ProvisionFailure["funding"],
    });
  }

  return body as unknown as ProvisionResult;
}
