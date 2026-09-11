# capsule-client

Front end for **Capsule** — the ENSv2 agent launchpad. `/launch` mints capsules and
`/fleet` reads them back off ETH Sepolia; both sign with the visitor's own wallet.
`/analyst` answers questions from the live fleet subgraph through The Graph.

```
npm install
cp .env.example .env.local   # the RPC, the minter, the store, Fly
npm run dev                  # http://localhost:3000
```


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
