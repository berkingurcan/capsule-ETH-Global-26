# capsule-client

Front end for **Capsule** — the ENSv2 agent launchpad. This is the design demo:
every screen is real and clickable, and every number behind it is mock data.
Nothing here connects a wallet, calls a contract or talks to a server.

```
npm install
npm run dev      # http://localhost:3000
```

## The screens

| Route | What it shows |
|---|---|
| `/` | The pitch, and the mechanic diagram — how an agent dies |
| `/launch` | The five-step launchpad: parent → roles → configure → mint → live |
| `/fleet` | Every capsule you own: records, heartbeat, recall |
| `/fleet/[label]` | One agent: its record table, its heartbeat, its live log, its gateway |
| `/analyst` | The fleet analyst — questions answered off the subgraph |

And three server routes, which are not design demo:

| Route | What it does |
|---|---|
| `/api/prompt/[ref]` | Hands an agent its prompt body, against a signed request |
| `/api/runtime` | Hands an agent its Telegram bot token and model key, same scheme |
| `/schema/capsule-agent-v1.json` | The ENSIP-27 schema every minted name points at |

## What the UI is arguing

The point of the product is that **the name is the agent**, so the interface has to
make that visible rather than claim it:

- **The record is the settings screen.** On `/fleet/[label]` the config table *is*
  the ENS record, and every row says who may write it. That column is not an
  opinion — it is read from `WRITER` in `lib/capsule/records.ts`, which mirrors the
  EAC grants `CapsuleMinter.mint()` actually makes. Only `agent-heartbeat` belongs
  to the agent.
- **The keys are the ENSIPs, not ours.** `class` and `schema` are ENSIP-27;
  `agent-context` and `agent-endpoint[web]` are ENSIP-26; the registration key is
  ENSIP-25. A client that speaks them can read a capsule without knowing what
  Capsule is, and the UI says so because that is the ENSv2 argument.
- **The heartbeat is the liveness indicator.** The runner writes `agent-heartbeat`
  to its own name, and that write needs a role scoped to that one key. The counter
  on each card is that write, not a ping.
- **Recall is one call, not a teardown.** The dialog pulls one role. The next
  heartbeat reverts with `EACUnauthorizedAccountRoles`, the runner stops the
  OpenClaw gateway and exits on its own — the subname and records stay, and the
  bot stops answering.
- **One chain, no money.** x402 and ERC-4337 were cut on 2026-09-08; see
  `DECISIONS.md` in the branding repo. Everything is ETH Sepolia.

## Design rules it follows

From `../BRAND.md`, and they are not decoration:

1. Every object gets a 3px ink outline.
2. Every raised object gets a hard offset shadow, zero blur.
3. One accent owns each surface. No gradients, no soft shadows.

Colour is semantic and load-bearing: **Bubble** is the only colour that spends
money, **Mint** means running, **Sun** is the 402 stamp and any warning, and
**Alarm** red appears on recall and nowhere else. Rubik for anything a person
wrote; Azeret Mono for anything a machine issued — an ENS name is always
machine-issued.

## Where the fake data lives

All of it is in [`lib/mock.ts`](lib/mock.ts): agents, roles, the activity feed and
the analyst's three worked answers. Swapping it for ENSv2 reads and subgraph queries
is the next job — the component props are already shaped like what those return.

What is **not** mock: `lib/capsule/` and everything under `app/api/`. The record
keys, the signed-request contracts, the encrypted store and the two service routes
are the real thing, and `npm run check:wire` asserts the copied halves still agree
with `runner/src/`.

## Not wired up

Wallet connection, contract calls, the provisioner route, Fly log streams and the
MCP server are all simulated on timers. The launchpad's mint step plays out the real
sequence so the flow can be demoed end to end without a chain.
