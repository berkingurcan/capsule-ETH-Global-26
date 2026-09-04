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
| `/launch` | The six-step launchpad: parent → roles → configure → x402 → mint → live |
| `/fleet` | Every capsule you own: heartbeat, balance, recall |
| `/fleet/[label]` | One agent: its record, its heartbeat interval, its live log, its money |
| `/analyst` | The fleet analyst — questions answered off both subgraphs |

## What the UI is arguing

The point of the product is that **the name is the agent**, so the interface has to
make that visible rather than claim it:

- **The record is the settings screen.** On `/fleet/[label]` the config table *is*
  the ENS record, and every row says who may write it. Only `agent.heartbeat`
  belongs to the agent.
- **The heartbeat is the liveness indicator.** The runner writes to its own name
  every 60 seconds, and that write needs an EAC role. The counter on each card is
  that write, not a ping.
- **Recall is one call, not a teardown.** The dialog pulls one role. The next
  heartbeat reverts with `EACUnauthorizedAccountRoles` and the runner exits on its
  own — the subname and records stay.
- **Two chains, no bridge.** Anything that came off Sepolia is tagged `Sepolia`;
  anything that came off Base is tagged `Base`. Money is pink, everywhere.

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

All of it is in [`lib/mock.ts`](lib/mock.ts): agents, roles, the activity feed,
payments and the analyst's three worked answers. Swapping it for ENSjs reads and
two subgraph queries is the next job — the component props are already shaped like
what those return.

## Not wired up

Wallet connection, contract calls, the x402 handshake, Fly log streams and the MCP
server are all simulated on timers. The launchpad's payment and mint steps play out
the real sequence so the flow can be demoed end to end without a chain.
