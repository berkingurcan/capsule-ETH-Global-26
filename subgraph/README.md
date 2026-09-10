# The Capsule fleet subgraph

Mints, record writes, role changes and heartbeats for Capsule's ENSv2 agent
names — ETH Sepolia, one index.

## What it indexes, and why it has to be a join

A Capsule agent is one ENS subname. Everything true about it is spread across
two contracts that never emit the same event:

| Source | Event | What it says |
| --- | --- | --- |
| `CapsuleMinter` | `CapsuleMinted` | which names exist, who owns them, which agent key they name |
| `CapsuleMinter` | `ParentConnected` | which ENS names may issue capsules, and **which resolver theirs use** |
| `PermissionedResolver` | `TextChanged` | what each name currently says — model, prompt pointer, runtime, heartbeat |
| `PermissionedResolver` | `EACRolesChanged` | whether the agent may still write its own heartbeat |
| `PermissionedResolver` | `AddrChanged` | the identity link the runner refuses to boot without |

`web/lib/capsule/fleet.ts` reads all of that over `eth_getLogs` and reconciles
it in memory on every page render. That file's own header documents four bugs
found in doing so, and every one of them was silent — an empty array, not an
error. That is the argument for the index: the join happens once, where it can
be tested, instead of per render, where a wrong answer looks like a quiet one.

## One static source, one template

There is no single resolver address to point a manifest at. Every ENS name that
connects to the minter gets its **own** `PermissionedResolver`, deployed as a
UUPS proxy through `VerifiableFactory`, and its address is not knowable when
`subgraph.yaml` is written.

`ParentConnected` is what publishes it. So `handleParentConnected` spawns a
`PermissionedResolver` data source the moment a name connects — the same
discovery the runner does at boot through `UniversalResolverV2`, done once at
index time rather than on every read.

Two consequences worth knowing before reading the mappings:

- **The mint handler back-fills.** `mint()` emits `CapsuleMinted` *after* it has
  already granted roles and set `addr`, so those events arrive before the
  `Capsule` exists and are skipped. `mint()` does the same three things every
  time, so the handler asserts them directly. See the comment at the top of
  `src/minter.ts`.
- **A resolver is not a capsule.** It serves every name its owner holds. Both
  record handlers return early for a node the minter never issued, and role
  changes are attributed through `ResourceRef` — `EACRolesChanged` carries a
  hashed resource and nothing else.

## The field this exists for

```graphql
{
  roleChanges(where: { revoked: true, resourceKind: "agent-heartbeat" }) {
    capsule { name beatCount lastInterval }
    secondsSinceLastBeat
    beatsAtChange
    changedBy
  }
}
```

`secondsSinceLastBeat` pairs a revocation off the resolver with the agent's last
write off the same resolver on a completely different cadence. Compared against
that capsule's own `lastInterval`, it answers "did this agent die, or was it
stopped?" — which is the difference between an infrastructure failure and the
product's headline feature, and which no single contract emits enough
information to settle.

## Layout

```
schema.graphql          entities; the comments say what each one is for
subgraph.yaml           one data source (CapsuleMinter) + one template (the resolver)
src/records.ts          record keys + the EAC resource derivation
src/minter.ts           mints, parents, resolver discovery
src/resolver.ts         records, heartbeats, role changes — the join
tests/records.test.ts   the three derivations that fail silently
abis/                   hand-written, events only — no eth_call surface we do not use
```

`src/records.ts` is the **fourth** copy of the record-key table (the others are
`contracts/src/CapsuleMinter.sol`, `runner/src/records.ts`,
`web/lib/capsule/records.ts`). `cd web && npm run check:records` asserts all
four agree. It is the copy where drift is least visible: a stale key here still
indexes and still serves, it simply attributes nothing — every recall silently
missing, and a fleet that renders as though no role was ever pulled.

## Build and test

```bash
npm install
npm run codegen
npm run build
npm test              # macOS: needs libpq; `npx graph test -d` runs it in Docker
```

The tests do not need a chain or a deployment. They check the three derivations
whose failure mode is a well-formed subgraph that is quietly wrong: the EAC
resource hash (expected values taken from `viem` against the same inputs the
dashboard and `CapsuleMinter.textResourceOf` use), the DNS wire-name decoder,
and the heartbeat sequence parser.

## Deploy

The manifest is pinned to the current minter:

```yaml
address: "0xE114CAf799f11Ed61Bd44Fc7d498D96Db62bDF51"
startBlock: 11669320
```

Both must match `CAPSULE_MINTER_ADDRESS` and `CAPSULE_MINTER_BLOCK` in
`web/.env.local`. A redeployed minter changes both, and the ENSIP-25
registration key derived from the minter address changes with it.

```bash
# 1. Create the subgraph in Subgraph Studio (thegraph.com/studio), then:
npx graph auth <STUDIO_DEPLOY_KEY>

# 2. Deploy. Studio prints the query URL and the subgraph id.
npx graph deploy <SUBGRAPH_SLUG>
```

Then, in `web/.env.local`:

```bash
# The dashboard reads the index directly over the Studio query URL.
SUBGRAPH_URL=https://api.studio.thegraph.com/query/<account>/<slug>/<version>

# The analyst reaches the same subgraph through The Graph's hosted Subgraph MCP
# server, which addresses subgraphs by id and authenticates with a gateway key.
SUBGRAPH_ID=<the base58 subgraph id, not the URL>
GRAPH_API_KEY=<gateway API key from Subgraph Studio>
ANTHROPIC_API_KEY=<...>
```

`SUBGRAPH_URL` is optional. Unset — or set and failing, or still syncing — and
`/fleet` falls back to the chain reader; the dashboard prints which one served
it and how many blocks behind the head the index was. That fallback is the one
silent-degradation in the app that is deliberate, and it is only acceptable
because it is visible on the page.

## Local indexing

```bash
docker compose up          # graph-node + ipfs + postgres, pointed at Sepolia
npm run create-local
npm run deploy-local
```

There is no `docker-compose.yml` in this repo; use the one from
`graphprotocol/graph-node` and set `ethereum: 'sepolia:<your RPC>'`.
