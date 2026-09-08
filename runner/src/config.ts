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
import {
  KEY_CONTEXT,
  KEY_ENDPOINT_CAPSULE,
  KEY_ENDPOINT_WEB,
  KEY_HEARTBEAT,
  KEY_MODEL,
  KEY_PROMPT,
  KEY_RUNTIME,
  READ_KEYS,
  REQUIRED_KEYS,
  RUNTIME_OPENCLAW,
} from "./records.js";
import { decodeText, encodeName, resolverAbi, universalResolverAbi } from "./resolve.js";

export { KEY_HEARTBEAT } from "./records.js";

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
   * Opaque to the runner. Which SDK actually serves it is the brain's problem;
   * dispatch on this string there, and a new provider is a new row in a map
   * rather than a contract change. Swapping the value on chain is one setText.
   */
  model: string;
  /** `agent-endpoint[capsule]` — the control plane. Required. */
  endpoint: string;
  /** A pointer such as "cap_8f3d1a". Never the prompt body — that stays off chain. */
  promptRef: string;
  /**
   * `agent-runtime`. Empty on a name minted before runtimes were named; treated as
   * openclaw, because that is the only thing this binary can supervise. A name asking
   * for something else is a hard failure rather than a silent substitution — see boot.
   */
  runtime: string;
  /** ENSIP-26 `agent-context`. Passed to the runtime as the agent's description. */
  context: string;
  /**
   * ENSIP-26 `agent-endpoint[web]` — the Telegram bot, e.g. `https://t.me/foo_bot`.
   * Empty is normal: an owner can publish the bot after minting.
   */
  webEndpoint: string;
  heartbeat: Heartbeat;
};

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join("; "));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * The one record the agent may write. It appears in three places — the write
 * itself, the config read, and the owner's authorizeTextRoles grant — so it is
 * spelled once, in records.ts, alongside every other key. A typo does not fail
 * loudly: it authorises one key and writes another, and the revert says nothing
 * useful about which.
 */
export const HEARTBEAT_KEY = KEY_HEARTBEAT;

/** Records that must be present. The heartbeat is deliberately not among them. */
const REQUIRED_TEXT = REQUIRED_KEYS;
const TEXT_KEYS = READ_KEYS;

/** "beat-7" -> 7, "" -> 0. Tolerates anything; the runner should not die of this. */
function parseSequence(raw: string): number {
  const match = /(\d+)\s*$/.exec(raw);
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

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

  for (const key of REQUIRED_TEXT) {
    if (text[key] === "") problems.push(`${key} — not set on this name`);
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const heartbeatRaw = text[KEY_HEARTBEAT] ?? "";

  // Unset means a name minted before `agent-runtime` existed, which predates any runtime
  // but this one. A name naming a DIFFERENT runtime is refused rather than coerced: this
  // process can only supervise OpenClaw, and pretending otherwise would boot an agent
  // that is not the one the record describes.
  const runtime = text[KEY_RUNTIME] === "" ? RUNTIME_OPENCLAW : (text[KEY_RUNTIME] ?? RUNTIME_OPENCLAW);
  if (runtime !== RUNTIME_OPENCLAW) {
    throw new ConfigError([`${KEY_RUNTIME} — "${runtime}" is not a runtime this binary can supervise`]);
  }

  return {
    name: normalized,
    node,
    resolver: resolver as Address,
    agent,
    model: text[KEY_MODEL]!,
    endpoint: text[KEY_ENDPOINT_CAPSULE]!,
    promptRef: text[KEY_PROMPT]!,
    runtime,
    context: text[KEY_CONTEXT] ?? "",
    webEndpoint: text[KEY_ENDPOINT_WEB] ?? "",
    heartbeat: { raw: heartbeatRaw, sequence: parseSequence(heartbeatRaw) },
  };
}
