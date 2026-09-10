/**
 * Canned answers for the analyst page. THIS IS NOT REAL DATA.
 *
 * The analyst is meant to be a Subgraph MCP server over a Sepolia subgraph, and
 * the subgraph is not built yet. Until it is, this page is a scripted
 * demonstration of the shape of the answer, and it says so on screen.
 *
 * It lives in its own file, named for what it is, rather than in a shared
 * `mock.ts`. The fleet pages import nothing from here — everything on /fleet is
 * read from the chain — and the point of the separation is that it stays that
 * way: an import of this module from anywhere else is a bug you can grep for.
 *
 * The numbers below are drawn from the real Phase 5 gate run (see
 * Branding-ENSClaw/GATE-LOG.md), so they are at least true of something that
 * happened, rather than invented outright.
 */

export type Answer = {
  q: string;
  a: string;
  rows?: { name: string; value: string; note?: string }[];
  source: string;
};

export const ANSWERS: Answer[] = [
  {
    q: "Which agents changed config today, and who authorised it?",
    a: "One record changed. analyst.capsulefleet.eth had agent-prompt rewritten twice — to cap_7b21e9 and back to cap_8f3d1a — and both writes came from the parent, capsulefleet.eth, not from the agent. The agent only holds the heartbeat role, so it could not have made this change itself.",
    rows: [
      { name: "analyst.capsulefleet.eth", value: "agent-prompt", note: "written by capsulefleet.eth · 0x9aa2…f2a2" },
      { name: "trader.capsulefleet.eth", value: "no change", note: "set at mint, never edited" },
      { name: "dev.capsulefleet.eth", value: "no change", note: "set at mint, never edited" },
    ],
    source: "subgraph-sepolia · TextChanged, EACRolesChanged",
  },
  {
    q: "Show me anything that stopped heartbeating before it was recalled.",
    a: "Nothing did. analyst.capsulefleet.eth wrote beat-9 and the revoke landed 14 seconds later — one tick, not one heartbeat. The agent did not fail; the permission was pulled and the next write reverted with EACUnauthorizedAccountRoles. That is the kill switch working, not a crash.",
    rows: [
      { name: "analyst.capsulefleet.eth", value: "gap 14s", note: "beat-9 → revoke, then exit 0" },
      { name: "analyst.capsulefleet.eth", value: "regranted", note: "beat-10 landed after the role came back" },
      { name: "trader.capsulefleet.eth", value: "no beats", note: "minted, never booted" },
    ],
    source: "subgraph-sepolia · heartbeat writes vs EACRolesChanged",
  },
];
