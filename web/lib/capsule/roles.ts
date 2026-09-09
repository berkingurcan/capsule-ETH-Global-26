/**
 * The role presets the launchpad offers, and the colours the fleet draws with.
 *
 * This is configuration, not mock data. Nothing here is read from the chain
 * because none of it is on the chain: a preset is a starting point for the mint
 * form — a suggested label, a model, a context line and a prompt body — and the
 * moment a capsule exists, every one of those values is read back from its
 * name instead. Nothing on /fleet renders a preset.
 *
 * The one thing presets are still used for after a mint is decoration:
 * `capColor` gives a known label its established colour so the fleet does not
 * reshuffle on every deploy, and falls back to a hash for labels nobody
 * anticipated.
 */

export type Role = {
  slug: string;
  title: string;
  blurb: string;
  /** Cap colour of the capsule mark. */
  cap: string;
  /** `<provider>/<model>` — the value written to the agent-model record. */
  model: string;
  /** agent-context — what this agent is, in plain language. */
  context: string;
  /** The prompt body. Never on chain; the record holds a pointer. */
  prompt: string;
};

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
  },
];

const PALETTE = ["#FFC42E", "#8CF0B4", "#FF4D8D", "#6E95F0", "#C4D5F6", "#B8A6F0"];

export function roleOf(slug: string): Role | undefined {
  return ROLES.find((role) => role.slug === slug);
}

/** A stable colour for a label, preset or not. */
export function capColor(label: string): string {
  const preset = roleOf(label);
  if (preset !== undefined) return preset.cap;
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

/** The display name for a label. Falls back to the label itself, capitalised. */
export function roleTitle(label: string): string {
  return roleOf(label)?.title ?? label.charAt(0).toUpperCase() + label.slice(1);
}
