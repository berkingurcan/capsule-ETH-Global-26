/**
 * The capsule — everything the runner is, read off its own name.
 *
 * One multicall, five records, and three kinds of failure that must never be
 * confused with each other:
 *
 *   value is ""          the owner has not configured this. Their problem, fixable
 *   the read failed      the chain or the RPC is unwell. Not the agent's fault
 *   addr is someone else this runner is not this agent. Refuse to boot
 *
 * None of them is the revoke. The revoke is a write failing, it lives in the
 * heartbeat path, and the whole point of being strict here is that when the
 * runner finally dies there is exactly one thing it can mean.
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { UNIVERSAL_RESOLVER_V2 } from "./chain.js";
import { shortRevert } from "./errors.js";
import { decodeText, encodeName, resolverAbi, universalResolverAbi } from "./resolve.js";
import {
  POLICY_KEYS,
  RECORD_KEYS,
  REQUIRED_TEXT_KEYS,
  TEXT_KEYS,
  parseHeartbeatSequence,
} from "./records.js";
import { parseSpendPolicy, type SpendPolicy } from "./policy.js";
import { modelRefProblems, parseModelRef, type ModelRef } from "./providers.js";

// Re-exported so the rest of the runner keeps importing it from here, which is
// where it has always lived. The string itself is now defined once, in records.ts.
export { HEARTBEAT_KEY } from "./records.js";

export type Heartbeat = {
  /** As written on chain, e.g. "beat-7". Empty if the agent has never beaten. */
  raw: string;
  /** The trailing integer, 0 when unset. The next write is sequence + 1. */
  sequence: number;
};

export type CapsuleConfig = {
  name: string;
  node: Hex;
  /** Discovered, never hardcoded — every owner has their own resolver proxy. */
  resolver: Address;
  /** The `addr` record. Verified to be this runner's own address. */
  agent: Address;
  /**
   * `<provider>/<model>` — OpenClaw's own model-reference syntax, handed to the
   * gateway verbatim as `agents.defaults.model.primary`. Still opaque to the
   * chain: the minter writes it as a string and validates nothing, so a new
   * provider is a new row in `providers.ts` rather than a contract redeploy.
   * Swapping the value on chain is one setText, and the agent becomes a
   * different brain in the same container.
   */
  model: string;
  /**
   * The same value, split. Parsed here rather than at each use so a malformed
   * reference is caught by the one function that already knows the difference
   * between "the owner misconfigured this" and "the chain is unwell".
   */
  modelRef: ModelRef;
  endpoint: string;
  /** A pointer such as "cap_8f3d1a". Never the prompt body — that stays off chain. */
  promptRef: string;
  heartbeat: Heartbeat;
  /**
   * What this agent may spend, read off the same name as everything else.
   *
   * Never a reason to fail the load. The policy records are optional — no
   * deployed minter writes them and every capsule that predates them has none —
   * so an absent, empty or malformed value resolves to "cannot spend" and is
   * reported rather than thrown. A capsule that refused to boot because its
   * owner mistyped a spending cap would be a capsule taken down by a typo, and
   * on a dashboard that is indistinguishable from a recall.
   */
  spend: SpendPolicy;
};

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join("; "));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

// The key strings live in ./records.ts — see the note there on why a typo in
// one of them looks exactly like a revocation.

export async function loadCapsuleConfig(
  client: PublicClient,
  name: string,
  /**
   * The address this runner holds the key for. Passed in rather than read from
   * the environment so this stays a pure function of (chain, name, identity).
   */
  expectedAgent: Address,
): Promise<CapsuleConfig> {
  const { name: normalized, node, dnsName } = encodeName(name);

  const inner: Hex[] = [
    // addr(bytes32) — a different inner ABI from text(), same outer resolve().
    encodeFunctionData({ abi: resolverAbi, functionName: "addr", args: [node] }),
    ...TEXT_KEYS.map((key) =>
      encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [node, key] }),
    ),
  ];

  // One round trip. The loop re-reads this every tick forever; five separate
  // calls is how you get rate-limited off a public RPC halfway through a demo.
  // allowFailure keeps a single bad record from hiding the other four.
  const results = await client.multicall({
    contracts: inner.map((data) => ({
      address: UNIVERSAL_RESOLVER_V2,
      abi: universalResolverAbi,
      functionName: "resolve",
      args: [dnsName, data],
    })),
    allowFailure: true,
  });

  const problems: string[] = [];
  const readFailures: { label: string; reason: string }[] = [];
  let resolver: Address | undefined;

  const raw = (index: number, label: string): Hex | undefined => {
    const entry = results[index];
    if (entry === undefined || entry.status !== "success") {
      const reason = entry?.status === "failure" ? shortRevert(entry.error) : "no result";
      readFailures.push({ label, reason });
      return undefined;
    }
    const [data, answeredBy] = entry.result as readonly [Hex, Address];
    resolver ??= answeredBy;
    return data;
  };

  const addrData = raw(0, "addr");
  const textData = TEXT_KEYS.map((key, offset) => raw(offset + 1, key));

  // A name with no resolver fails every read for the same reason. Saying so
  // five times buries the one fact that matters: the name is not there.
  if (readFailures.length > 0) {
    const reasons = new Set(readFailures.map((failure) => failure.reason));
    if (readFailures.length === inner.length && reasons.size === 1) {
      const reason = [...reasons][0]!;
      problems.push(
        reason === "ResolverNotFound"
          ? `${normalized} — no resolver for this name. Has it been minted?`
          : `${normalized} — every read failed: ${reason}`,
      );
    } else {
      for (const failure of readFailures) {
        problems.push(`${failure.label} — read failed: ${failure.reason}`);
      }
    }
  }

  // addr — the identity link. See the refusal below.
  let agent = zeroAddress as Address;
  if (addrData !== undefined) {
    agent =
      addrData === "0x"
        ? zeroAddress
        : decodeFunctionResult({ abi: resolverAbi, functionName: "addr", data: addrData });
    if (agent === zeroAddress) {
      problems.push("addr — not set on this name");
    } else if (!isAddressEqual(agent, expectedAgent)) {
      // ENS reads are public; only writes are permissioned. Nothing on chain
      // stops a runner booting against someone else's name and impersonating
      // it everywhere off chain. The protocol defends the name. The runner has
      // to defend the identity.
      problems.push(`addr — ${agent} is not this runner (${expectedAgent})`);
    }
  }

  const text: Record<string, string> = {};
  TEXT_KEYS.forEach((key, offset) => {
    const data = textData[offset];
    if (data === undefined) return;
    text[key] = decodeText(data);
  });

  for (const key of REQUIRED_TEXT_KEYS) {
    if (text[key] === "") problems.push(`${key} — not set on this name`);
  }

  // The model reference has to be readable before anything downstream can act on
  // it. Note where this lands: a ConfigError is fatal at boot and survivable in
  // the loop, because the loop keeps the last good config and warns. An owner who
  // fat-fingers a model name on a running capsule must not take it down — a dead
  // agent and a revoked one look identical on a dashboard, and only one of them
  // is this system's headline feature.
  const rawModel = text[RECORD_KEYS.model] ?? "";
  if (rawModel !== "") {
    for (const problem of modelRefProblems(rawModel)) {
      problems.push(`${RECORD_KEYS.model} — ${problem}`);
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const heartbeatRaw = text[RECORD_KEYS.heartbeat] ?? "";

  return {
    name: normalized,
    node,
    resolver: resolver as Address,
    agent,
    model: rawModel,
    // Non-null because modelRefProblems above already rejected everything the
    // parser returns null for, and a problem there threw.
    modelRef: parseModelRef(rawModel)!,
    endpoint: text[RECORD_KEYS.endpointCapsule]!,
    promptRef: text[RECORD_KEYS.prompt]!,
    heartbeat: { raw: heartbeatRaw, sequence: parseHeartbeatSequence(heartbeatRaw) },
    // Below the `problems.length > 0` throw on purpose. These two records are
    // the only ones on the name whose absence is normal, and `parseSpendPolicy`
    // reports rather than raises for the same reason — see the field comment.
    spend: parseSpendPolicy(text[POLICY_KEYS.spendCap] ?? "", text[POLICY_KEYS.spendAllow] ?? ""),
  };
}
