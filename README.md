# Capsule — ENSv2 Agent Launchpad

**MVP for ETH Global Online 26**

Capsule lets you mint on-chain AI agents as ENS names. Connect a wallet, configure an agent, and mint it as a subname — then the runner keeps it alive with heartbeats, or halts it on revoke.

## Live on Ethereum Sepolia
https://capsule-ens.vercel.app/

## How to Use the Platform

**1. Get a name.** If you don't own a `.eth` name yet, [Register a name](https://capsule-ens.vercel.app/register) — pick one, pay with test tokens. That name is now yours. (Skip this if you already have one.)

**2. Plug it in.** Go to [Connect a name](https://capsule-ens.vercel.app/connect) and link your `.eth`. You're giving Capsule permission to create agents *under* your name — like giving someone keys to a room in your house, not your house. You can take the keys back anytime.

**3. Hire an agent (5 clicks).** Open the [Launchpad](https://capsule-ens.vercel.app/launch) and walk the five steps:
   1. **Wallet** — connect your wallet (Sepolia)
   2. **Roles** — pick what the agent may do
   3. **Configure** — give it a name, a brain, and paste its secrets (e.g. Telegram API key)
   4. **Mint** — the agent is born on-chain as `myname.yourname.eth`
   5. **Provision** — spin up the runner so it starts living

**4. Watch your fleet.** Open the [Fleet](https://capsule-ens.vercel.app/fleet) dashboard. Every agent you own shows its heartbeat, its cash, and its latest logs. If it's beating, it's alive and working.

**5. Stop one anytime.** Hit *Recall* on any agent. It keeps its name and memories, but loses the one permission it needs to write — so on its very next beat it shuts itself down.

**6. Ask questions.** The [Analyst](https://capsule-ens.vercel.app/analyst) answers plain questions about your fleet ("did any agent go silent before it was recalled?") by reading the live subgraph — and shows you the query it ran.

## Project Structure

| Directory | Description |
|---|---|
| `web/` | Next.js frontend & backend — launchpad + fleet dashboard |
| `runner/` | Agent process — resolves its ENS name, heartbeats, halts on revoke. 2 Layers: OpenClaw AI and Supervisor |
| `contracts/` | Solidity: CapsuleMinter, resolver, roles |
| `subgraph/` | The Graph — mints, records, roles and heartbeats in one index. Agent guide: [`subgraph/SKILL.md`](subgraph/SKILL.md) |

## Key Features

- **No-Code Deployment** — 5-click launchpad. Paste API keys, agent goes live on Telegram in minutes. No terminals, no DevOps.
- **On-Chain Identity & Ownership** — Every agent gets its own ENS v2 subdomain and wallet. Identity and authority live onchain — no 3rd party can lock you out.
- **Heartbeat Liveness** — Agent proves it's alive by writing to its own ENS name on a cadence. One on-chain record, observable by anyone.
- **Owner-Controlled Permissions** — Spending caps, role-based access, and kill switch all enforced onchain via the resolver. Only you set these rules.
- **Real-Time Fleet Indexing** — The Graph Protocol indexes agent activity, heartbeat statuses, and permission updates live from the blockchain.

## Learn More

- [Web frontend](web/) — launchpad + dashboard
- [Runner](runner/) — the agent process
- [Contracts](contracts/) — Solidity source