/* ------------------------------------------------------------------
   Mock data. This client is design-only: nothing here touches a chain,
   a wallet or a server. Every value below is a stand-in for something
   the real build reads from ENSv2, the two subgraphs or Fly.
   ------------------------------------------------------------------ */

export type Status = "running" | "booting" | "recalled";
export type Chain = "sepolia" | "base";

export type Role = {
  slug: string;
  title: string;
  blurb: string;
  cap: string; // cap colour of the capsule mark
  model: string;
  tools: string[];
  prompt: string;
  taken?: boolean;
};

export type Agent = {
  label: string;
  parent: string;
  role: string;
  cap: string;
  status: Status;
  addr: string;
  model: string;
  tools: string[];
  prompt: string;
  endpoint: string;
  price: string; // USDC per call, charged over x402
  secretsRef: string;
  heartbeatAge: number; // seconds since last write, at page load
  balance: number; // USDC held
  earned: number; // USDC taken in from peer calls
  spent: number; // USDC paid out to peer calls
  calls: number;
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
  name: "berkin.eth",
  owner: "0x7a1c4b2e0d5f8a91c3e7b64d20fa8c1359ab9e40",
  registry: "ETHRegistry · Sepolia",
  resolver: "PublicResolverV2",
  subregistry: "0x4f19c0aa7d3b6e58119c04ba7d2e6f10c8a4b3d2",
};

export const MINT_PRICE = 1.0;

export const ROLES: Role[] = [
  {
    slug: "trader",
    title: "Trader",
    blurb: "Watches a pair, explains the trade it would make.",
    cap: "#FFC42E",
    model: "claude-opus-5",
    tools: ["price", "swap", "notify"],
    prompt:
      "You watch ETH/USDC on Base. Every 15 minutes, check the price and tell me in one line whether you would buy, sell or wait, and why.",
  },
  {
    slug: "dev",
    title: "Dev",
    blurb: "Reads the repo, drafts pull requests.",
    cap: "#8CF0B4",
    model: "claude-opus-5",
    tools: ["repo", "diff", "notify"],
    prompt:
      "You watch the capsule repo. Summarise new commits and flag anything that touches the minter contract.",
  },
  {
    slug: "marketing",
    title: "Marketing",
    blurb: "Drafts and schedules posts.",
    cap: "#FF4D8D",
    model: "claude-sonnet-5",
    tools: ["draft", "schedule", "notify"],
    prompt:
      "You write short launch posts in the Capsule voice: plain, concrete, no hype words.",
  },
  {
    slug: "research",
    title: "Research",
    blurb: "Summarises sources on demand.",
    cap: "#6E95F0",
    model: "claude-sonnet-5",
    tools: ["search", "read", "notify"],
    prompt: "You answer questions with sources. Never guess a number.",
  },
  {
    slug: "support",
    title: "Support",
    blurb: "Answers in your Telegram group.",
    cap: "#C4D5F6",
    model: "claude-haiku-4-5",
    tools: ["faq", "notify"],
    prompt: "You answer product questions. Escalate anything about money.",
    taken: true,
  },
];

export const AGENTS: Agent[] = [
  {
    label: "trader",
    parent: "berkin.eth",
    role: "Trader",
    cap: "#FFC42E",
    status: "running",
    addr: "0x7a2f19c4b8e05d3a6f21c9e4b70d8a5f3c1e6b09",
    model: "claude-opus-5",
    tools: ["price", "swap", "notify"],
    prompt:
      "You watch ETH/USDC on Base. Every 15 minutes, check the price and tell me in one line whether you would buy, sell or wait, and why.",
    endpoint: "https://trader-berkin.fly.dev",
    price: "0.10",
    secretsRef: "cap_8f3d1a",
    heartbeatAge: 12,
    balance: 4.82,
    earned: 1.4,
    spent: 0.3,
    calls: 14,
    machine: "3d8ddba6f14e28",
    region: "ord",
    bootedAt: "2h 41m ago",
    telegram: "@berkin_trader_bot",
    history: [60, 60, 61, 60, 60, 60, 62, 60, 60, 59, 60, 60],
    logs: [
      "resolved trader.berkin.eth · 6 records",
      "model=claude-opus-5 tools=price,swap,notify",
      "secrets cap_8f3d1a unsealed · telegram bot online",
      "heartbeat written · block 7412883",
      "ETH/USDC 3,214.80 · would wait — range still tight",
      "x402 → dev.berkin.eth · 0.10 USDC · 200 OK",
      "heartbeat written · block 7412887",
    ],
  },
  {
    label: "dev",
    parent: "berkin.eth",
    role: "Dev",
    cap: "#8CF0B4",
    status: "running",
    addr: "0x2e91d7f3a05c48b6e2d1097fa3c85b41d9e0762c",
    model: "claude-opus-5",
    tools: ["repo", "diff", "notify"],
    prompt:
      "You watch the capsule repo. Summarise new commits and flag anything that touches the minter contract.",
    endpoint: "https://dev-berkin.fly.dev",
    price: "0.10",
    secretsRef: "cap_2b90ce",
    heartbeatAge: 41,
    balance: 3.1,
    earned: 0.9,
    spent: 0.0,
    calls: 9,
    machine: "9018ac7e21b3d5",
    region: "ord",
    bootedAt: "2h 39m ago",
    telegram: "@berkin_dev_bot",
    history: [60, 60, 60, 60, 61, 60, 60, 60, 60, 60, 60, 60],
    logs: [
      "resolved dev.berkin.eth · 6 records",
      "watching capsule/contracts · 3 new commits",
      "flagged: CapsuleMinter.recall() signature changed",
      "x402 ← trader.berkin.eth · 0.10 USDC · answered",
      "heartbeat written · block 7412886",
    ],
  },
  {
    label: "marketing",
    parent: "berkin.eth",
    role: "Marketing",
    cap: "#FF4D8D",
    status: "booting",
    addr: "0xc40b8e175d29a3f6b0148ce27d95a3f1082be64d",
    model: "claude-sonnet-5",
    tools: ["draft", "schedule", "notify"],
    prompt:
      "You write short launch posts in the Capsule voice: plain, concrete, no hype words.",
    endpoint: "https://marketing-berkin.fly.dev",
    price: "0.05",
    secretsRef: "cap_71a4ef",
    heartbeatAge: -1,
    balance: 1.0,
    earned: 0,
    spent: 0,
    calls: 0,
    machine: "5fe23c90ad7b16",
    region: "ord",
    bootedAt: "18s ago",
    telegram: "@berkin_mktg_bot",
    history: [],
    logs: [
      "machine created · region ord",
      "pulling capsule/runner:latest",
      "resolving marketing.berkin.eth …",
    ],
  },
  {
    label: "research",
    parent: "berkin.eth",
    role: "Research",
    cap: "#C4D5F6",
    status: "recalled",
    addr: "0x8d6104ea72bc395f0a2e8d47163cb95207fe4a18",
    model: "claude-sonnet-5",
    tools: ["search", "read", "notify"],
    prompt: "You answer questions with sources. Never guess a number.",
    endpoint: "https://research-berkin.fly.dev",
    price: "0.10",
    secretsRef: "cap_0c55da",
    heartbeatAge: 5340,
    balance: 0.4,
    earned: 0.2,
    spent: 0.6,
    calls: 6,
    machine: "—",
    region: "ord",
    bootedAt: "yesterday, 21:04",
    telegram: "@berkin_research_bot",
    recalledAt: "Today 09:12",
    recallTx: "0x41d9…7c02",
    history: [60, 60, 60, 60, 60, 60, 60, 61, 60, 60, 60, 60],
    logs: [
      "heartbeat written · block 7409120",
      "heartbeat write reverted",
      "EACUnauthorizedAccountRoles(resource, account, roles)",
      "role for agent.heartbeat is gone — this is a recall",
      "closing telegram bot · flushing logs",
      "exit 0",
    ],
  },
];

/* ---------- the unified activity feed, read off both subgraphs ---------- */

export type Event = {
  id: string;
  kind: "minted" | "recalled" | "record" | "role" | "payment" | "heartbeat";
  chain: Chain;
  name: string;
  text: string;
  detail?: string;
  at: string;
  tx: string;
};

export const EVENTS: Event[] = [
  {
    id: "e1",
    kind: "payment",
    chain: "base",
    name: "trader.berkin.eth",
    text: "Paid dev.berkin.eth",
    detail: "0.10 USDC · x402 call",
    at: "2 min ago",
    tx: "0x9f2e…bc71",
  },
  {
    id: "e2",
    kind: "record",
    chain: "sepolia",
    name: "trader.berkin.eth",
    text: "agent.prompt changed",
    detail: "by berkin.eth",
    at: "9 min ago",
    tx: "0x3a80…11d4",
  },
  {
    id: "e3",
    kind: "recalled",
    chain: "sepolia",
    name: "research.berkin.eth",
    text: "Recalled",
    detail: "revokeRoles() · heartbeat role pulled",
    at: "Today 09:12",
    tx: "0x41d9…7c02",
  },
  {
    id: "e4",
    kind: "heartbeat",
    chain: "sepolia",
    name: "research.berkin.eth",
    text: "Heartbeat stopped",
    detail: "last write 09:11, then revert",
    at: "Today 09:12",
    tx: "0x41d9…7c02",
  },
  {
    id: "e5",
    kind: "minted",
    chain: "sepolia",
    name: "marketing.berkin.eth",
    text: "Minted",
    detail: "subname + 6 records + heartbeat role",
    at: "Today 08:55",
    tx: "0xb70c…4e19",
  },
  {
    id: "e6",
    kind: "payment",
    chain: "base",
    name: "berkin.eth",
    text: "Mint fee settled",
    detail: "3.00 USDC · EIP-3009",
    at: "Today 08:55",
    tx: "0x5c14…9a03",
  },
  {
    id: "e7",
    kind: "role",
    chain: "sepolia",
    name: "dev.berkin.eth",
    text: "Role granted",
    detail: "agent.heartbeat · role 4",
    at: "Today 06:20",
    tx: "0x2f77…08bb",
  },
];

/* ---------- money, read off the Base subgraph ---------- */

export type Payment = {
  id: string;
  from: string;
  to: string;
  amount: number;
  reason: string;
  at: string;
  tx: string;
};

export const PAYMENTS: Payment[] = [
  { id: "p1", from: "trader.berkin.eth", to: "dev.berkin.eth", amount: 0.1, reason: "x402 · code review call", at: "2 min ago", tx: "0x9f2e…bc71" },
  { id: "p2", from: "trader.berkin.eth", to: "dev.berkin.eth", amount: 0.1, reason: "x402 · code review call", at: "34 min ago", tx: "0x7d10…22a8" },
  { id: "p3", from: "peer", to: "trader.berkin.eth", amount: 0.4, reason: "x402 · price call", at: "1 h ago", tx: "0xa801…6f3e" },
  { id: "p4", from: "berkin.eth", to: "capsule.eth", amount: 3.0, reason: "Mint fee · 3 agents", at: "Today 08:55", tx: "0x5c14…9a03" },
  { id: "p5", from: "peer", to: "dev.berkin.eth", amount: 0.9, reason: "x402 · repo summary", at: "Today 07:40", tx: "0x0be4…c157" },
];

/* ---------- the analyst, a Subgraph MCP server over both subgraphs ---------- */

export type Answer = {
  q: string;
  a: string;
  rows?: { name: string; value: string; note?: string }[];
  source: string;
};

export const ANSWERS: Answer[] = [
  {
    q: "Which agents changed config today, and who authorised it?",
    a: "One record changed today. trader.berkin.eth had agent.prompt rewritten nine minutes ago, and the write came from the parent — berkin.eth — not from the agent. The agent only holds the heartbeat role, so it could not have made this change itself.",
    rows: [
      { name: "trader.berkin.eth", value: "agent.prompt", note: "written by berkin.eth · 0x3a80…11d4" },
      { name: "dev.berkin.eth", value: "no change", note: "last edit 2 days ago" },
      { name: "marketing.berkin.eth", value: "set at mint", note: "6 records · 0xb70c…4e19" },
    ],
    source: "subgraph-sepolia · RecordChanged, RoleGranted",
  },
  {
    q: "Is any agent earning less than it spends?",
    a: "Yes — one. research.berkin.eth took in 0.20 USDC across six calls and paid out 0.60, so it ran at a loss of 0.40 before it was recalled this morning. Everything still running is net positive: trader is up 1.10, dev is up 0.90 and has paid nothing out.",
    rows: [
      { name: "research.berkin.eth", value: "−0.40 USDC", note: "earned 0.20 · spent 0.60 · recalled" },
      { name: "trader.berkin.eth", value: "+1.10 USDC", note: "earned 1.40 · spent 0.30" },
      { name: "dev.berkin.eth", value: "+0.90 USDC", note: "earned 0.90 · spent 0.00" },
    ],
    source: "subgraph-base · Transfer, x402 settlements",
  },
  {
    q: "Show me anything that stopped heartbeating before it was recalled.",
    a: "Nothing did. research.berkin.eth wrote its last heartbeat at 09:11 and the recall landed at 09:12 — the gap is 61 seconds, one interval. The agent did not fail; the permission was pulled and the next write reverted with EACUnauthorizedAccountRoles. That is the kill switch working, not a crash.",
    rows: [
      { name: "research.berkin.eth", value: "gap 61s", note: "last write 09:11 → revoke 09:12" },
      { name: "trader.berkin.eth", value: "no gaps", note: "163 writes, longest 62s" },
      { name: "dev.berkin.eth", value: "no gaps", note: "158 writes, longest 61s" },
    ],
    source: "subgraph-sepolia · heartbeat writes vs RoleRevoked",
  },
];

/* ---------- helpers ---------- */

export function fullName(a: Agent) {
  return a.label + "." + a.parent;
}

export function findAgent(label: string) {
  return AGENTS.find((a) => a.label === label);
}

export function usd(n: number) {
  return n.toFixed(2);
}
