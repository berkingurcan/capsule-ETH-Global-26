# Capsule — Web

The launchpad and fleet dashboard for Capsule. A Next.js app that turns an ENSv2 subname into a live AI agent.

## Pages

| Route | What it does |
|---|---|
| `/launch` | Mint an agent in 5 steps: wallet → roles → configure → mint → provision |
| `/fleet` | Live dashboard: heartbeats, balances, logs, recall button |
| `/connect` | Wire your own `.eth` name so you can mint agents under it |
| `/register` | Register a new `.eth` name (Sepolia testnet) |
| `/analyst` | Ask plain-language questions about your fleet; reads the subgraph |

## Stack

- **Next.js 15** (App Router) + **React 19** — pages and API routes in `app/`
- **viem** — wallet signing and chain reads, browser and server
- **Neon Postgres** — encrypted secret store (`db/migrations/`)
- **OpenAI** — the `/analyst` route
- **Fly Machines** — one container per running agent, created by the provisioner
- **The Graph** — optional subgraph that indexes agent activity

## How it fits together

```
Browser wallet ── mints ──► CapsuleMinter (../contracts)
      │
      ├─ /api/capsule/prepare    store prompt + agent key (encrypted, Postgres)
      ├─ /api/capsule/provision  start a Fly machine that runs the agent
      ├─ /api/prompt/[ref]       serve the agent its prompt + credentials
      └─ /fleet                  read heartbeats off the chain (or the subgraph)
```

The agent's identity is the ENS name, and its permission to live is **one writable
record** (`agent-heartbeat`). Only the owner revoking that permission on-chain can stop
an agent — nothing the web app does can. The backend is convenience, not authority.

## Getting started

```
cp .env.example .env.local   # fill in: RPC, minter, Neon, Fly token, funder key
npm install
npm run db:migrate           # create the secret-store tables
npm run dev                  # http://localhost:3000
```

Every env var is explained in `.env.example`. The minter address and its deploy block
come from the `../contracts` deploy scripts.

## Commands

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `start` | run the app |
| `npm run lint` / `typecheck` | static checks |
| `npm run db:migrate` | apply SQL migrations |
| `npm run seed:dev` | seed local dev data |
| `npm run preflight` | check env + chain + Fly wiring before a demo |

## The checks

None send a transaction. Each asserts a promise a passing build does not, against a
live `.env.local`.

| Script | What it proves |
|---|---|
| `npm run check:records` | record keys agree across Solidity, runner, and web |
| `npm run check:wire` | web↔runner message format agrees (reads runner source) |
| `npm run check:fleet` | the read path: events, resource ids, `authorized` |
| `npm run check:mint` | the mint, simulated — struct order, reverts, event |
| `npm run check:recall` | the kill switch, from the owner and from a stranger |
| `npm run check:prepare` / `check:provision` | the two server routes (provision builds and deletes a real Fly machine) |
| `npm run check:register` | `/register` vs live chain — tokens, `mintable`, 60s window |
| `npm run check:subgraph` | drift guard: fleet query vs subgraph schema, pinned minter values |