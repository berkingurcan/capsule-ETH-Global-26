/* ------------------------------------------------------------------
   Mock data. This client is design-only: nothing here touches a chain,
   a wallet or a server. Every value below is a stand-in for something
   the real build reads from ENSv2 or Fly.

   One chain. ERC-4337 and x402 were cut on 2026-09-08 (DECISIONS.md),
   so there are no balances, no USDC and no Base rows here — an agent
   costs gas to beat and nothing else.

   The record keys are NOT spelled here. Anything that renders a key
   imports it from lib/capsule/records.ts, which is the copy the
   contract and the runner are checked against.
   ------------------------------------------------------------------ */

export type Status = "running" | "booting" | "recalled";

export type Role = {
  slug: string;
  title: string;
  blurb: string;
  cap: string; // cap colour of the capsule mark
  model: string; // `<provider>/<model>` — the value of the agent-model record
  context: string; // agent-context — what this agent is, in plain language
  prompt: string; // the body. Never on chain; the record holds a pointer.
  taken?: boolean;
};

export type Agent = {
  label: string;
  parent: string;
  role: string;
  cap: string;
  status: Status;

  /* --- the records, as they are actually written at mint --- */
  addr: string;
  model: string;
  runtime: string;
  context: string;
  /** agent-prompt. A pointer such as `cap_8f3d1a`, never the body. */
  promptRef: string;
  /** agent-endpoint[web] — the human-facing surface. */
  telegramUrl: string;
  /** agent-endpoint[capsule] — the control plane the runner fetches from. */
  capsuleEndpoint: string;
  /** The URI in the `schema` record. */
  schemaUri: string;
  /** The ENSIP-25 key, already parameterised. Value is always "1". */
  registration: string;
  /** agent-heartbeat, as the agent last wrote it. Empty until it boots. */
  heartbeat: string;

  /* --- everything below is off chain --- */
  prompt: string;
  heartbeatAge: number; // seconds since last write, at page load
  machine: string;
  region: string;
  bootedAt: string;
  telegram: string;
  recalledAt?: string;
  recallTx?: string;
  history: number[]; // heartbeat intervals, seconds — 1 point per minute
  logs: string[];
};

export const PARENT = {
  name: "capsulefleet.eth",
  owner: "0x9e0283E37bd2f2c6bEFC29b89CF2d86fe5b5fB71",
  registry: "ETHRegistry · Sepolia",
  resolver: "PermissionedResolver",
  subregistry: "0x4f19c0aa7d3b6e58119c04ba7d2e6f10c8a4b3d2",
};

/** Every capsule points at the same published schema document. */
const SCHEMA_URI = "https://capsule.vercel.app/schema/capsule-agent-v1.json";

/** The control plane. `agent-endpoint[capsule]` on every name. */
const CONTROL_PLANE = "https://capsule.vercel.app";

/** ENSIP-25. The registry half is the minter as an ERC-7930 address. */
const REGISTRY_INTEROP = "0x0000e60100e609ae1cfb8277ce14286428aa1d0d88a337a362";

function registrationOf(tokenId: number) {
  return `agent-registration[${REGISTRY_INTEROP}][${tokenId}]`;
}

export const ROLES: Role[] = [
  {
    slug: "trader",
    title: "Trader",
    blurb: "Watches a pair, explains the trade it would make.",
    cap: "#FFC42E",
    model: "anthropic/claude-opus-5",
    context: "Reads a price feed and says what it would do about it.",
    prompt:
      "You watch ETH/USDC on Sepolia. Every 15 minutes, check the price and tell me in one line whether you would buy, sell or wait, and why.",
  },
  {
    slug: "dev",
    title: "Dev",
    blurb: "Reads the repo, drafts pull requests.",
    cap: "#8CF0B4",
    model: "openai/gpt-5.6-sol",
    context: "Follows a repository and reports what changed.",
    prompt:
      "You watch the capsule repo. Summarise new commits and flag anything that touches the minter contract.",
  },
  {
    slug: "marketing",
    title: "Marketing",
    blurb: "Drafts and schedules posts.",
    cap: "#FF4D8D",
    model: "google/gemini-3.1-pro-preview",
    context: "Writes short launch copy in the Capsule voice.",
    prompt:
      "You write short launch posts in the Capsule voice: plain, concrete, no hype words.",
  },
  {
    slug: "research",
    title: "Research",
    blurb: "Summarises sources on demand.",
    cap: "#6E95F0",
    model: "deepseek/deepseek-v4-flash",
    context: "Answers questions and cites where the answer came from.",
    prompt: "You answer questions with sources. Never guess a number.",
  },
  {
    slug: "analyst",
    title: "Analyst",
    blurb: "Reports what the fleet did.",
    cap: "#C4D5F6",
    model: "openai/gpt-5.6-luna",
    context: "Reads the fleet's own chain activity and reports on it.",
    prompt: "You are the analyst for a small ENS-native agent fleet.",
    taken: true,
  },
];

export const AGENTS: Agent[] = [
  {
    label: "trader",
    parent: PARENT.name,
    role: "Trader",
    cap: "#FFC42E",
    status: "running",
    addr: "0x7a2f19c4b8e05d3a6f21c9e4b70d8a5f3c1e6b09",
    model: "anthropic/claude-opus-5",
    runtime: "openclaw",
    context: "Reads a price feed and says what it would do about it.",
    promptRef: "cap_8f3d1a",
    telegramUrl: "https://t.me/berkin_trader_bot",
    capsuleEndpoint: CONTROL_PLANE,
    schemaUri: SCHEMA_URI,
    registration: registrationOf(4),
    heartbeat: "beat-7",
    prompt:
      "You watch ETH/USDC on Sepolia. Every 15 minutes, check the price and tell me in one line whether you would buy, sell or wait, and why.",
    heartbeatAge: 12,
    machine: "3d8ddba6f14e28",
    region: "ord",
    bootedAt: "2h 41m ago",
    telegram: "@berkin_trader_bot",
    history: [60, 60, 61, 60, 60, 60, 62, 60, 60, 59, 60, 60],
    logs: [
      "resolved trader.capsulefleet.eth · 9 records",
      "agent-model=anthropic/claude-opus-5",
      "ANTHROPIC_API_KEY loaded · openclaw gateway up · telegram bot online",
      "heartbeat written · beat-6 · block 11662608 · 47,639 gas",
      "ETH/USDC 3,214.80 · would wait — range still tight",
      "telegram: answered @berkin in 1072ms",
      "heartbeat written · beat-7 · block 11662615 · 47,639 gas",
    ],
  },
  {
    label: "dev",
    parent: PARENT.name,
    role: "Dev",
    cap: "#8CF0B4",
    status: "running",
    addr: "0x2e91d7f3a05c48b6e2d1097fa3c85b41d9e0762c",
    model: "openai/gpt-5.6-sol",
    runtime: "openclaw",
    context: "Follows a repository and reports what changed.",
    promptRef: "cap_2b90ce",
    telegramUrl: "https://t.me/berkin_dev_bot",
    capsuleEndpoint: CONTROL_PLANE,
    schemaUri: SCHEMA_URI,
    registration: registrationOf(5),
    heartbeat: "beat-5",
    prompt:
      "You watch the capsule repo. Summarise new commits and flag anything that touches the minter contract.",
    heartbeatAge: 41,
    machine: "9018ac7e21b3d5",
    region: "ord",
    bootedAt: "2h 39m ago",
    telegram: "@berkin_dev_bot",
    history: [60, 60, 60, 60, 61, 60, 60, 60, 60, 60, 60, 60],
    logs: [
      "resolved dev.capsulefleet.eth · 9 records",
      "watching capsule/contracts · 3 new commits",
      "flagged: CapsuleMinter.mint() signature changed",
      "telegram: sent commit digest",
      "heartbeat written · beat-5 · block 11662611 · 47,639 gas",
    ],
  },
  {
    label: "marketing",
    parent: PARENT.name,
    role: "Marketing",
    cap: "#FF4D8D",
    status: "booting",
    addr: "0xc40b8e175d29a3f6b0148ce27d95a3f1082be64d",
    model: "google/gemini-3.1-pro-preview",
    runtime: "openclaw",
    context: "Writes short launch copy in the Capsule voice.",
    promptRef: "cap_71a4ef",
    telegramUrl: "https://t.me/berkin_mktg_bot",
    capsuleEndpoint: CONTROL_PLANE,
    schemaUri: SCHEMA_URI,
    registration: registrationOf(6),
    heartbeat: "",
    prompt:
      "You write short launch posts in the Capsule voice: plain, concrete, no hype words.",
    heartbeatAge: -1,
    machine: "5fe23c90ad7b16",
    region: "ord",
    bootedAt: "18s ago",
    telegram: "@berkin_mktg_bot",
    history: [],
    logs: [
      "machine created · region ord",
      "pulling capsule/runner:latest",
      "resolving marketing.capsulefleet.eth …",
    ],
  },
  {
    label: "research",
    parent: PARENT.name,
    role: "Research",
    cap: "#C4D5F6",
    status: "recalled",
    addr: "0x8d6104ea72bc395f0a2e8d47163cb95207fe4a18",
    model: "deepseek/deepseek-v4-flash",
    runtime: "openclaw",
    context: "Answers questions and cites where the answer came from.",
    promptRef: "cap_0c55da",
    telegramUrl: "https://t.me/berkin_research_bot",
    capsuleEndpoint: CONTROL_PLANE,
    schemaUri: SCHEMA_URI,
    registration: registrationOf(3),
    heartbeat: "beat-9",
    prompt: "You answer questions with sources. Never guess a number.",
    heartbeatAge: 5340,
    machine: "—",
    region: "ord",
    bootedAt: "yesterday, 21:04",
    telegram: "@berkin_research_bot",
    recalledAt: "Today 09:12",
    recallTx: "0x41d9…7c02",
    history: [60, 60, 60, 60, 60, 60, 60, 61, 60, 60, 60, 60],
    logs: [
      "heartbeat written · beat-9 · block 11662590",
      "denied — setText(agent-heartbeat) refused by the resolver",
      "EACUnauthorizedAccountRoles(resource, roleBitmap, account)",
      "confirmed no ROLE_SET_TEXT on agent-heartbeat — this is a recall",
      "gateway stopped — the bot is offline",
      "exit 0",
    ],
  },
];

/* ---------- the unified activity feed, read off ETH Sepolia ---------- */

export type Event = {
  id: string;
  kind: "minted" | "recalled" | "record" | "role" | "heartbeat";
  name: string;
  text: string;
  detail?: string;
  at: string;
  tx: string;
};

export const EVENTS: Event[] = [
  {
    id: "e1",
    kind: "heartbeat",
    name: "trader.capsulefleet.eth",
    text: "Heartbeat written",
    detail: "beat-7 · 47,639 gas",
    at: "2 min ago",
    tx: "0x8be3…2a8d",
  },
  {
    id: "e2",
    kind: "record",
    name: "trader.capsulefleet.eth",
    text: "agent-prompt changed",
    detail: "by capsulefleet.eth",
    at: "9 min ago",
    tx: "0x9aa2…f2a2",
  },
  {
    id: "e3",
    kind: "recalled",
    name: "research.capsulefleet.eth",
    text: "Recalled",
    detail: "authorizeTextRoles(agent-heartbeat, false)",
    at: "Today 09:12",
    tx: "0x3f65…c9cc",
  },
  {
    id: "e4",
    kind: "heartbeat",
    name: "research.capsulefleet.eth",
    text: "Heartbeat stopped",
    detail: "last write 09:11, then revert",
    at: "Today 09:12",
    tx: "0x3f65…c9cc",
  },
  {
    id: "e5",
    kind: "minted",
    name: "marketing.capsulefleet.eth",
    text: "Minted",
    detail: "subname + 9 records + heartbeat role",
    at: "Today 08:55",
    tx: "0xb70c…4e19",
  },
  {
    id: "e6",
    kind: "role",
    name: "dev.capsulefleet.eth",
    text: "Role granted",
    detail: "agent-heartbeat · ROLE_SET_TEXT",
    at: "Today 06:20",
    tx: "0x2f77…08bb",
  },
];

/* ---------- the analyst, a Subgraph MCP server over ETH Sepolia ---------- */

export type Answer = {
  q: string;
  a: string;
  rows?: { name: string; value: string; note?: string }[];
  source: string;
};

export const ANSWERS: Answer[] = [
  {
    q: "Which agents changed config today, and who authorised it?",
    a: "One record changed today. trader.capsulefleet.eth had agent-prompt rewritten nine minutes ago, and the write came from the parent — capsulefleet.eth — not from the agent. The agent only holds the heartbeat role, so it could not have made this change itself.",
    rows: [
      { name: "trader.capsulefleet.eth", value: "agent-prompt", note: "written by capsulefleet.eth · 0x9aa2…f2a2" },
      { name: "dev.capsulefleet.eth", value: "no change", note: "last edit 2 days ago" },
      { name: "marketing.capsulefleet.eth", value: "set at mint", note: "9 records · 0xb70c…4e19" },
    ],
    source: "subgraph-sepolia · TextChanged, RolesGranted",
  },
  {
    q: "Show me anything that stopped heartbeating before it was recalled.",
    a: "Nothing did. research.capsulefleet.eth wrote its last heartbeat at 09:11 and the recall landed at 09:12 — the gap is 61 seconds, one interval. The agent did not fail; the permission was pulled and the next write reverted with EACUnauthorizedAccountRoles. That is the kill switch working, not a crash.",
    rows: [
      { name: "research.capsulefleet.eth", value: "gap 61s", note: "last write 09:11 → revoke 09:12" },
      { name: "trader.capsulefleet.eth", value: "no gaps", note: "163 writes, longest 62s" },
      { name: "dev.capsulefleet.eth", value: "no gaps", note: "158 writes, longest 61s" },
    ],
    source: "subgraph-sepolia · heartbeat writes vs RolesRevoked",
  },
];

/* ---------- helpers ---------- */

export function fullName(a: Agent) {
  return a.label + "." + a.parent;
}

export function findAgent(label: string) {
  return AGENTS.find((a) => a.label === label);
}
