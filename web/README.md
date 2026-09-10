# capsule-client

Front end for **Capsule** — the ENSv2 agent launchpad. `/launch` mints capsules and
`/fleet` reads them back off ETH Sepolia; both sign with the visitor's own wallet.
The one page still on canned data is `/analyst`, which says so on screen.

```
npm install
cp .env.example .env.local   # the RPC, the minter, the store, Fly
npm run dev                  # http://localhost:3000
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
  the ENS record, and every row says who may write it. Only `agent-heartbeat`
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

One file, named for what it is: [`lib/analyst-demo.ts`](lib/analyst-demo.ts), the
analyst's worked answers, pending the subgraph. Nothing on `/fleet` imports it —
every value there is read from the chain — and an import of it from anywhere else is
a bug you can grep for.

## The checks

None of them send a transaction, and each one asserts something a passing build does
not. Run them against a live `.env.local`.

| | |
|---|---|
| `npm run check:records` | the record keys agree across Solidity, runner and web |
| `npm run check:fleet` | the read path: resource ids, event signatures, `authorized` |
| `npm run check:mint` | the mint, simulated — struct order, reverts, `CapsuleMinted` |
| `npm run check:recall` | the kill switch, simulated from the real owner and from a stranger |
| `npm run check:prepare` / `check:provision` | the two server routes |

## Not wired up

The x402 handshake, Fly log streams and the MCP analyst are still simulated. The
recall is not: `/fleet` sends `authorizeTextRoles(dnsName, "agent-heartbeat", agent,
false)` from the owner's wallet to the name's own resolver, and reports the capsule
recalled only after reading the permission back.
