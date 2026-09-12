---
name: capsule-fleet-subgraph
description: This skill should be used when answering questions about Capsule's ENSv2 AI agents on Ethereum Sepolia — which agents exist, who owns them, what each is configured to run, whether it is still permitted to write, and whether one went silent before or after it was recalled. Covers the fleet subgraph's entities, the three states that look alike and are not, and GraphQL recipes taken from the shipped queries.
version: 1.0.0
---

# Capsule fleet subgraph

Read a fleet of on-chain AI agents out of one index. Every agent in Capsule is an
ENSv2 subname — `analyst.capsulefleet.eth` — and everything true about it is an
event from one of two contracts that never emit together. This subgraph is that
join, done once at index time.

## Before the first query

Never answer from this file. It describes the shape of the data, not its contents.

Read the schema first, every time — a deployed subgraph outranks a document
committed next to it.

There are two ways in, and which one is live depends on whether the subgraph has
been published to the decentralized network:

| State | Endpoint | Tools |
| --- | --- | --- |
| Published to the network | `gateway.thegraph.com` | Subgraph MCP: `get_schema_by_subgraph_id`, then `execute_query_by_subgraph_id` |
| Deployed to Studio only | the Studio query URL in `SUBGRAPH_URL` | `get_subgraph_schema`, then `run_subgraph_query` |

Two traps in the published case. The base58 **subgraph id** minted at publish and
the `Qm…` **IPFS deployment hash** that `graph deploy` prints are not
interchangeable — passing the hash to the subgraph-id tool answers
`invalid subgraph ID`, with no hint as to why. And the gateway serves *only*
published subgraphs: a Studio deployment is unreachable through it by every
identifier it accepts, which reports as `subgraph not found` rather than as a
configuration problem. `subgraph/README.md` has the measurements.

## The distinction that matters most

Three things look alike in this data and mean completely different things. Getting
these confused is the one way to be badly wrong about whether an agent is alive:

1. **Recalled** — `authorized: false`. The owner revoked the agent's
   `ROLE_SET_TEXT` on its `agent-heartbeat` key. The agent did not fail; it was
   stopped, deliberately, by a transaction. Its subname, records and whole history
   survive. **This is the product's headline feature, not a fault.**
2. **Silent** — `authorized: true`, but no recent heartbeat. The permission is
   intact and the machine is not running. An infrastructure problem, not an ENS
   one.
3. **Never booted** — minted, `beatCount: 0`. Nothing ever ran.

`secondsSinceLastBeat` on a `RoleChange` is what settles (1) against (2), and it
is the field this subgraph exists for: it pairs a revocation off the resolver with
the agent's last write off that same resolver on an unrelated cadence. Compare it
against that capsule's own `lastInterval` — if the gap is many multiples of the
observed interval, the agent had already stopped before anyone pulled the role.

## Domain model

The name *is* the agent, not a label on one:

- **Configuration** lives in the name's ENSIP-26 text records — `agent-model`,
  `agent-prompt`, `agent-runtime`, `agent-context`, `agent-endpoint[web]`,
  `agent-endpoint[capsule]`. The subgraph exposes each as a current-value field on
  `Capsule` (`model`, `prompt`, `runtime`, `context`, `endpointWeb`,
  `endpointCapsule`).
- **Permission** lives in ENSv2's `PermissionedResolver`, scoped per name *and*
  per record key. The agent's own wallet may write exactly one key,
  `agent-heartbeat`, and nothing else — so a compromised agent cannot rewrite its
  own instructions.
- **The kill switch** is the owner revoking that one role in one transaction.
  Enforced by ENS, not by any backend.

A heartbeat is an on-chain write of `beat-<n>`, a monotonic counter — never a
timestamp — paid for by the agent's own key at roughly 47,639 gas.

## Entities

| Entity | One row is | Reach for it when |
| --- | --- | --- |
| `Parent` | an ENS name that connected itself to `CapsuleMinter` and may issue agents | "whose fleets exist", `capsuleCount`, `open`, `connected`, which `resolver` |
| `Capsule` | one agent: identity, current records, permission, heartbeat state, config churn | almost every question |
| `RecordWrite` | one `setText` | "who changed this agent's config, and when" — `writer` is the address that signed |
| `Heartbeat` | one beat, with the gap before it already measured | liveness, cadence, `interval` |
| `RoleChange` | one permission change on the heartbeat key or the name | recalls, grants, `secondsSinceLastBeat`, `beatsAtChange` |
| `Fleet` | deployment-wide totals, one row keyed by the minter | "how big is all of this" |

`ParentByNode`, `ResourceRef`, `AgentRef`, `RecordNode` and `ResolverSource` are
internal join tables the handlers need. They answer no user question — do not
query them.

Useful `Capsule` fields beyond the records: `name`, `label`, `owner`, `agent` (the
agent's own EOA, the least privileged key in the system), `addr`, `tokenId`,
`authorized`, `recallCount`, `recalledAt`, `beatCount`, `firstBeatAt`,
`lastBeatAt`, `lastInterval`, `configWriteCount`, `ownerWriteCount`,
`lastConfigChangeAt`.

## Recipes

**Scope to one fleet.** One minter serves every connected name, so "the fleet" is
not a thing that exists — a question about "my agents" is meaningless without
saying whose. `parent_` is graph-node's nested-entity filter; guessing at it costs
a wasted round trip.

```graphql
# Every agent under one parent, with liveness and permission.
{
  parents(where: { name: "capsulefleet.eth" }, first: 1) {
    name
    resolver
    capsules(first: 50, orderBy: mintedAtBlock, orderDirection: asc) {
      name
      owner
      agent
      model
      runtime
      prompt
      endpointWeb
      authorized
      beatCount
      lastBeatAt
      lastInterval
      recalledAt
    }
  }
}
```

```graphql
# Did anything stop beating before it was recalled?
# Compare secondsSinceLastBeat against that capsule's own lastInterval.
{
  roleChanges(
    where: { revoked: true, resourceKind: "agent-heartbeat" }
    orderBy: timestamp
    orderDirection: desc
    first: 20
  ) {
    capsule { name beatCount lastInterval }
    secondsSinceLastBeat
    beatsAtChange
    changedBy
    timestamp
  }
}
```

```graphql
# Config changes today, by whoever signed them. `isHeartbeat: false` is the
# filter that matters — heartbeats are record writes too, and they dwarf
# everything else by volume. Substitute midnight UTC of the current day for the
# literal below — it is `floor(now / 86400) * 86400`, not a constant to copy
# (1789171200 is 2026-09-12T00:00:00Z).
{
  recordWrites(
    where: {
      isHeartbeat: false
      timestamp_gte: 1789171200
      capsule_: { parent_: { name: "capsulefleet.eth" } }
    }
    orderBy: timestamp
    orderDirection: desc
    first: 50
  ) {
    capsule { name }
    key
    value
    writer
    byAgent
    timestamp
  }
}
```

```graphql
# Observed cadence for one agent, most recent first.
{
  capsules(where: { name: "analyst.capsulefleet.eth" }, first: 1) {
    name
    beatCount
    lastInterval
    heartbeats(first: 20, orderBy: sequence, orderDirection: desc) {
      sequence
      interval
      timestamp
      tx
    }
  }
}
```

```graphql
# Never booted: minted, and nothing ever ran.
{
  capsules(where: { beatCount: 0 }, first: 50) {
    name
    owner
    mintedAt
    authorized
  }
}
```

```graphql
# How far behind the chain is the index? Ask alongside anything time-sensitive.
{ _meta { block { number timestamp } hasIndexingErrors } }
```

Standard graph-node arguments are on every collection field: `where`, `orderBy`,
`orderDirection` (`asc`/`desc`), `first`, `skip`. Filter suffixes include `_gt`,
`_gte`, `_lt`, `_lte`, `_in`, `_not`, `_contains`, `_contains_nocase`.

## Facts that will make you wrong if you guess them

- **All timestamps are Unix seconds.** You have no clock. Get "now" from the
  caller, or from `_meta { block { timestamp } }` — never from your own idea of
  what year it is, and never spend a query triangulating the date before you
  start on the actual question.
- **A lagging index looks like a dead fleet.** If `_meta`'s timestamp is far from
  now, recent events are simply missing. Say so rather than reporting silence.
- **`prompt` is a pointer, not a prompt** — `cap_8f3d1a`. The body is never on
  chain. There is nothing to read out of it and no prompt to quote.
- **Cadence is observed, never declared.** `HEARTBEAT_SECONDS` lives in each
  runner's environment, so no interval is on chain. `lastInterval` is a
  measurement of the last two beats. The demo runs at 60s; the documented default
  is 28800. Do not call a gap "late" against a schedule you cannot see.
- **One agent key can hold one permission across several capsules.** On the
  hackathon resolver, `resource(key)` hashes the *key alone* — so revoking an
  agent's `ROLE_SET_TEXT` on `agent-heartbeat` stops it writing for **every** name
  that resolver serves. The batch mint script signs every capsule with one
  `AGENT_KEY`; the web provisioner generates a fresh key per capsule. So a single
  revoke may recall several agents at once, and a capsule sharing a recalled key
  is not alive no matter what its own row says. `AgentRef.capsules` is a list for
  exactly this reason.
- **Bytes ids are lowercase hex.** Addresses and namehashes compare
  case-sensitively in a `where` clause.
- **`owner` is the mint-time owner.** A transfer after the mint is not indexed.
- **Nothing here is a security boundary.** The whole index is public. Scoping to a
  parent shapes the answer to the question asked; it withholds nothing.

## How to answer

- Query first. Read the schema, then query; two turns, not a guess.
- Lead with one sentence that answers the question, then the specifics.
- Name names — `analyst.capsulefleet.eth`, not "one of the agents".
- Give numbers as they came back. Never round a count, never estimate a
  timestamp, never fill a gap with a plausible value.
- Distinguish "the fleet has never done this" from "I could not find it". An
  empty result set is a real answer and usually an interesting one.
- If the rows do not answer the question, say exactly that, and say what they do
  show. A confidently wrong answer about whether an agent is alive is worse than
  no answer.
- Show the GraphQL you ran.

## Related

- `subgraph/README.md` — what it indexes and why it has to be a join, the
  one-source-one-template manifest, build, test and deploy.
- `subgraph/schema.graphql` — the entities, with a comment on every field saying
  what it is for.
- `web/app/api/analyst/route.ts` — the shipped agent that uses this skill's
  knowledge as its system prompt, in both endpoint modes.
- `web/lib/capsule/fleet-graph.ts` — `FLEET_QUERY`, the nested read the dashboard
  renders from.
