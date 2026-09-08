/* ------------------------------------------------------------------
   Mock data. This client is design-only: nothing here touches a chain,
   a wallet or a server. Every value below is a stand-in for something
   the real build reads from ENSv2, the subgraph or Fly.

   One chain, and no money. x402 and ERC-4337 were cut on 2026-09-08
   (see DECISIONS.md in the branding repo), which took the Base leg, the
   USDC balances and the agent-to-agent payment feed with them. What is
   left is what the project actually argues: a name, its records, the
   permission under them, and a heartbeat.
   ------------------------------------------------------------------ */

export type Status = "running" | "booting" | "recalled";

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
  context: string; // agent-context, ENSIP-26
  endpoint: string; // agent-endpoint[capsule]
  runtime: string; // agent-runtime — "openclaw"
  secretsRef: string;
  heartbeatAge: number; // seconds since last write, at page load
  beats: number; // heartbeat writes since the mint
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
  owner: "0x7a1c4b2e0d5f8a91c3e7b64d20fa8c1359ab9e40",
  registry: "ETHRegistry · Sepolia",
  // Not PublicResolverV2 — that one authorises writes through the ENSv1
  // NameWrapper and cannot serve a v2-native name at all. Every owner gets
  // their own PermissionedResolver proxy from VerifiableFactory.
  resolver: "PermissionedResolver",
  subregistry: "0x4f19c0aa7d3b6e58119c04ba7d2e6f10c8a4b3d2",
};

export const ROLES: Role[] = [
  {
    slug: "trader",
    title: "Trader",
    blurb: "Watches a pair, explains the trade it would make.",
    cap: "#FFC42E",
    model: "claude-opus-5",
    tools: ["price", "swap", "notify"],
    prompt:
      "You watch ETH/USDC. Every 15 minutes, check the price and tell me in one line whether you would buy, sell or wait, and why.",
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
    parent: "capsulefleet.eth",
    role: "Trader",
    cap: "#FFC42E",
    status: "running",
    addr: "0x7a2f19c4b8e05d3a6f21c9e4b70d8a5f3c1e6b09",
    model: "claude-opus-5",
    tools: ["price", "swap", "notify"],
    prompt:
      "You watch ETH/USDC. Every 15 minutes, check the price and tell me in one line whether you would buy, sell or wait, and why.",
    endpoint: "https://trader-capsulefleet.fly.dev",
    runtime: "openclaw",
    context: "Trading analyst. Watches one pair and says what it would do.",
    secretsRef: "cap_8f3d1a",
    heartbeatAge: 12,
    beats: 163,
    machine: "3d8ddba6f14e28",
    region: "ord",
    bootedAt: "2h 41m ago",
    telegram: "@capsule_trader_bot",
    history: [60, 60, 61, 60, 60, 60, 62, 60, 60, 59, 60, 60],
    logs: [
      "resolved trader.capsulefleet.eth · 9 records",
      "model=claude-opus-5 tools=price,swap,notify",
      "prompt cap_8f3d1a unsealed · openclaw gateway up · telegram online",
      "heartbeat written · block 7412883",
      "ETH/USDC 3,214.80 · would wait — range still tight",
      "heartbeat written · block 7412887",
    ],
  },
  {
    label: "dev",
    parent: "capsulefleet.eth",
    role: "Dev",
    cap: "#8CF0B4",
    status: "running",
    addr: "0x2e91d7f3a05c48b6e2d1097fa3c85b41d9e0762c",
    model: "claude-opus-5",
    tools: ["repo", "diff", "notify"],
    prompt:
      "You watch the capsule repo. Summarise new commits and flag anything that touches the minter contract.",
    endpoint: "https://dev-capsulefleet.fly.dev",
    runtime: "openclaw",
    context: "Repo watcher. Summarises commits and flags contract changes.",
    secretsRef: "cap_2b90ce",
    heartbeatAge: 41,
    beats: 158,
    machine: "9018ac7e21b3d5",
    region: "ord",
    bootedAt: "2h 39m ago",
    telegram: "@capsule_dev_bot",
    history: [60, 60, 60, 60, 61, 60, 60, 60, 60, 60, 60, 60],
    logs: [
      "resolved dev.capsulefleet.eth · 9 records",
      "watching capsule/contracts · 3 new commits",
      "flagged: CapsuleMinter.recall() signature changed",
      "heartbeat written · block 7412886",
    ],
  },
  {
    label: "marketing",
    parent: "capsulefleet.eth",
    role: "Marketing",
    cap: "#FF4D8D",
    status: "booting",
    addr: "0xc40b8e175d29a3f6b0148ce27d95a3f1082be64d",
    model: "claude-sonnet-5",
    tools: ["draft", "schedule", "notify"],
    prompt:
      "You write short launch posts in the Capsule voice: plain, concrete, no hype words.",
    endpoint: "https://marketing-capsulefleet.fly.dev",
    runtime: "openclaw",
    context: "Drafts launch posts in the Capsule voice.",
    secretsRef: "cap_71a4ef",
    heartbeatAge: -1,
    beats: 0,
    machine: "5fe23c90ad7b16",
    region: "ord",
    bootedAt: "18s ago",
    telegram: "@capsule_mktg_bot",
    history: [],
    logs: [
      "machine created · region ord",
      "pulling capsule/runner:latest",
      "resolving marketing.capsulefleet.eth …",
    ],
  },
  {
    label: "research",
    parent: "capsulefleet.eth",
    role: "Research",
    cap: "#C4D5F6",
    status: "recalled",
    addr: "0x8d6104ea72bc395f0a2e8d47163cb95207fe4a18",
    model: "claude-sonnet-5",
    tools: ["search", "read", "notify"],
    prompt: "You answer questions with sources. Never guess a number.",
    endpoint: "https://research-capsulefleet.fly.dev",
    runtime: "openclaw",
    context: "Answers questions with sources.",
    secretsRef: "cap_0c55da",
    heartbeatAge: 5340,
    beats: 142,
    machine: "—",
    region: "ord",
    bootedAt: "yesterday, 21:04",
    telegram: "@capsule_research_bot",
    recalledAt: "Today 09:12",
    recallTx: "0x41d9…7c02",
    history: [60, 60, 60, 60, 60, 60, 60, 61, 60, 60, 60, 60],
    logs: [
      "heartbeat written · block 7409120",
      "heartbeat write reverted",
      "EACUnauthorizedAccountRoles(resource, account, roles)",
      "no ROLE_SET_TEXT on agent-heartbeat — this is a recall",
      "stopping openclaw gateway · telegram offline",
      "exit 0",
    ],
  },
];

/* ---------- the activity feed, read off the Sepolia subgraph ---------- */

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
    id: "e2",
    kind: "record",
    name: "trader.capsulefleet.eth",
    text: "agent-prompt changed",
    detail: "by capsulefleet.eth",
    at: "9 min ago",
    tx: "0x3a80…11d4",
  },
  {
    id: "e3",
    kind: "recalled",
    name: "research.capsulefleet.eth",
    text: "Recalled",
    detail: "authorizeTextRoles(agent-heartbeat, false)",
    at: "Today 09:12",
    tx: "0x41d9…7c02",
  },
  {
    id: "e4",
    kind: "heartbeat",
    name: "research.capsulefleet.eth",
    text: "Heartbeat stopped",
    detail: "last write 09:11, then revert",
    at: "Today 09:12",
    tx: "0x41d9…7c02",
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
    id: "e7",
    kind: "role",
    name: "dev.capsulefleet.eth",
    text: "Role granted",
    detail: "agent-heartbeat · ROLE_SET_TEXT",
    at: "Today 06:20",
    tx: "0x2f77…08bb",
  },
];

/* ---------- the analyst, a Subgraph MCP server over the Sepolia subgraph ---------- */

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
      { name: "trader.capsulefleet.eth", value: "agent-prompt", note: "written by capsulefleet.eth · 0x3a80…11d4" },
      { name: "dev.capsulefleet.eth", value: "no change", note: "last edit 2 days ago" },
      { name: "marketing.capsulefleet.eth", value: "set at mint", note: "6 records · 0xb70c…4e19" },
    ],
    source: "subgraph-sepolia · RecordChanged, RoleGranted",
  },
  {
    q: "Has any agent ever written a record it was not supposed to?",
    a: "No, and it is not a policy — it is not reachable. Every agent holds ROLE_SET_TEXT on exactly one resource, the one derived from its own node and agent-heartbeat, so all 463 writes signed by an agent key are heartbeats. Four attempts against other keys reverted with EACUnauthorizedAccountRoles, and three of those came from one agent inside the same minute — which is what a prompt injection looks like from the chain's side.",
    rows: [
      { name: "trader.capsulefleet.eth", value: "163 writes", note: "163 agent-heartbeat · 0 refused" },
      { name: "dev.capsulefleet.eth", value: "158 writes", note: "158 agent-heartbeat · 1 refused" },
      { name: "research.capsulefleet.eth", value: "142 writes", note: "142 agent-heartbeat · 3 refused, same minute" },
    ],
    source: "subgraph-sepolia · TextChanged, EACUnauthorizedAccountRoles",
  },
  {
    q: "Show me anything that stopped heartbeating before it was recalled.",
    a: "Nothing did. research.capsulefleet.eth wrote its last heartbeat at 09:11 and the recall landed at 09:12 — the gap is 61 seconds, one interval. The agent did not fail; the permission was pulled and the next write reverted with EACUnauthorizedAccountRoles. That is the kill switch working, not a crash.",
    rows: [
      { name: "research.capsulefleet.eth", value: "gap 61s", note: "last write 09:11 → revoke 09:12" },
      { name: "trader.capsulefleet.eth", value: "no gaps", note: "163 writes, longest 62s" },
      { name: "dev.capsulefleet.eth", value: "no gaps", note: "158 writes, longest 61s" },
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
