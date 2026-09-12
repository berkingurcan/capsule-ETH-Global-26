# Capsule — ENSv2 Sepolia notes

Everything below was verified against live contracts, not from docs.

## TWO deployments, one chain

There are two ENSv2 deployments live on Sepolia and they share nothing but the
chain id:

- **hackathon** — behind the official ENS hackathon portal, a LATER revision of
  the contracts, and the one ENS DevRel points entrants at. **Capsule runs here.**
- **beta** — ENS's own long-running ENSv2 beta. Where Capsule ran until the port.

A name registered on one does not exist on the other. `getSubregistry("capsulefleet")`
answers a real registry on both — because we registered the name twice, once on
each — but they are different names holding different records, and neither
registry can see the other's labels.

The registry ABI is **identical** across the two (selector-diffed from deployed
bytecode). The resolver ABI is **not** — see gotcha 16, which is the whole of the
port.

Capsule supports both at once and picks per name, never by configuration:
`CapsuleMinter.connectParent` probes the resolver and stores `Parent.inode`; the
web app detects from `ETHRegistry.findOwner`; the runner probes its own resolver
at boot; reads try both UniversalResolvers.

## What exists on-chain — hackathon deployment (LIVE)

| Thing | Address / value |
|---|---|
| Owner wallet (burner) | `0x9e0283E37bd2f2c6bEFC29b89CF2d86fe5b5fB71` |
| Parent name | `capsulefleet.eth` — registered on the hackathon deployment, block `11687688` |
| Our subregistry (`UserRegistry` proxy) | `0x29A54E5B2C9330cd2c295BDdBa3e43f533b58C03` |
| Our resolver (`PermissionedResolver` proxy) | `0x857ee929aceb4e1f798a4c66b9bc55aaa51b1948` |
| **`CapsuleMinter`** (ours) | `0x07A30CfFe5408d2a94b5CaF44C88AeF31b2786CF` — block `11687685` |
| …its ERC-7930 registry id | `0x0001000003aa36a71407a30cffe5408d2a94b5caf44c88aef31b2786cf` |
| Parent namehash | `0x036a91f25e11db713abf00b569adb0a03c248d7b9f291430dac6807860d4a6b3` |
| Parent DNS encoding | `0x0c63617073756c65666c6565740365746800` |
| Test agent EOA | `0xca266f69EE3EFed7eC71CE5062f5A07c18908905` |
| Capsules minted | `trader`, `dev`, `marketing`, `analyst` — all `.capsulefleet.eth` |

Superseded minters, all on the **beta** deployment and unreachable from the
hackathon one:

| | |
|---|---|
| ~~`0xE114CAf799f11Ed61Bd44Fc7d498D96Db62bDF51`~~ | multi-parent, beta |
| ~~`0x193Bb7dB059a6f93e796d97da278465d20224819`~~ | single-parent |
| ~~`0xe609aE1Cfb8277cE14286428Aa1D0D88A337a362`~~ | dotted keys |

## ENS hackathon deployment — contracts we call

| Contract | Address |
|---|---|
| ETHRegistrar | `0x7d1B7f586a62Ac3F54b9A396849757814283270b` |
| ETHRegistry | `0x1D78834d97c1D7b1A38c1deDBD1a287cFEd3971e` |
| RootRegistry | `0xe7f0D5724f8337e3Aa9A9910540341Ff4273fEd9` |
| UniversalResolver | `0xd26f2040D083Af1cD2962ba303F4BEa0c4faf142` |
| LabelStore | `0xd7351f76866123a7e49381f38a30a96adba7e855` |
| VerifiableFactory | `0x894bc9cC8ff1ad96B8a288C86A8C71D662C07780` |
| PermissionedResolverImpl | `0xa9d3814AB151BF6E37A427432795371a8361614e` |
| **UserRegistry impl** | `0x47B442d0CF617c41CAbAFf5f02f44DD1e5f72546` — subregistries are proxies of this |
| StandardRentPriceOracle | `0xFeba6589b5C1B35875C0389CCEDF83148B6eE71B` |
| Test USDC (fee, **freely mintable**) | `0xcBFD80F74375c54E545AF34788Ff465F96F66F05` |
| Test DAI (fee, freely mintable) | `0x93403a98c3A6be906585CD0D68447c0Fc600FB38` |
| ~~PublicResolverV2~~ | `0xF9de4979DdB290baF5B760D0e788125017Bc33f6` — **do not use**, see gotcha 2 |

Not published anywhere we could find — read out of the portal's own JS bundle and
then verified on chain. The LabelStore in particular is absent from the portal's
config object and was recovered from `UserRegistry`'s constructor arguments.

## ENSv2 Sepolia beta — contracts we call

Kept because Capsule still reads names here.

| Contract | Address |
|---|---|
| ETHRegistrar | `0xa88553f454b77203b0d036a05c894d555eaaa2cc` |
| ETHRegistry | `0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2` |
| RootRegistry | `0x8115186e8f2e0b0281e86ab91f0f48ba90364354` |
| UniversalResolverV2 | `0x4a1817d13e9cf196f471725176355c1234b63c70` |
| LabelStore | `0x532cd0cc4ac0793d838f71a67d29b2d790d18777` |
| VerifiableFactory | `0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef` |
| PermissionedResolverImpl | `0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e` |
| USDC (registration fee) | `0x1c7d4b196cb0c7b01d743fbc6116a902379c7238` |
| ~~PublicResolverV2~~ | `0xe7b9…` — **do not use**, see gotcha 2 |

## One minter, many parents

`CapsuleMinter` used to take `parentNode` and `parentDns` as constructor arguments and
`REGISTRY` as an immutable, which meant one deployment could only ever mint under
`capsulefleet.eth`. It no longer holds a parent at all: any name whose owner connects it
can issue capsules, and `dev.berkin.eth` and `trader.capsulefleet.eth` come from the same
contract.

**What changed on the ABI** — every one of these is a breaking change, and the web app
moved with them:

| Before | Now |
|---|---|
| `mint(label, owner, agent, config)` | `mint(registry, label, owner, agent, config)` |
| `nodeOf(label)` / `dnsNameOf(label)` | `nodeOf(registry, label)` / `dnsNameOf(registry, label)` |
| `isAgentAuthorized(label, agent)` | `isAgentAuthorized(registry, label, agent)` |
| `checkResolverRoles()` | `checkResolverRoles(resolver)` |
| `PARENT_NODE()`, `REGISTRY()`, `PARENT_DNS()` | gone — use `parentOf(registry)` |
| — | `connectParent`, `setParentOpen`, `disconnectParent`, `readiness`, `namehash` |
| `CapsuleMinted(node, owner, agent, …)` | `CapsuleMinted(parentNode, node, owner, agent, …)` |

`parentNode` is indexed and `agent` is not: three topics is the ABI limit, and a dashboard
showing one name's fleet filters on the parent every time it loads.

### The two decisions worth knowing

**A parent is registered once, not passed per mint.** `mint()` names only a registry;
everything else about the parent was stored by `connectParent`. The obvious alternative —
`mint(registry, resolver, parentDns, …)` — looks equivalent and is not: nothing on chain
ties a registry to a resolver, so a caller could pair a real parent's registry with a
resolver they control, pass every permission check against their own resolver, and register
a label under somebody else's name. Storing the triple behind an admin check makes that
combination unrepresentable.

**The admin check is `ROLE_REGISTRAR_ADMIN` on the parent's registry.** Held by whoever
deployed that registry — necessarily, or they could not have granted the minter
`ROLE_REGISTRAR` in the first place. No owner table, no allowlist, no signature scheme.
`open` then decides whether strangers may mint under a connected name: `true` for a demo
parent people are invited to try, `false` (the default) for a name somebody owns.

### The live deployment

`0xE114CAf799f11Ed61Bd44Fc7d498D96Db62bDF51`, deployed in block `11669320` and verified on
Etherscan. `capsulefleet.eth` is connected to it and **open**, so anyone may mint there.

**The four demo capsules were deliberately NOT re-minted.** `trader`, `dev`, `marketing` and
`analyst` are still registered through the superseded minter, still resolve, and the analyst
runner still holds its heartbeat role — nothing about them broke. But `/fleet` enumerates
capsules from `CapsuleMinted` logs, and those logs belong to the old minter, so the dashboard
reads empty until something is minted through the new one. Re-minting them is
`MintCapsules.s.sol`, which unregisters each name first; that was a deliberate call not to
disturb four live names, not an oversight.

Note also that the ENSIP-25 registration key is derived from the minter address, so the
records on those four names name a registry that is no longer the one issuing capsules.

### Deploying

```
# once, ever
CAPSULE_SCHEMA_URI=https://…/schema/capsule-agent-v1.json \
  forge script script/DeployCapsuleMinter.s.sol --rpc-url sepolia --broadcast

# once per name, by that name's own admin
MINTER=0x… \
SUBREGISTRY=0x4d2b9DB6b011425F12F271Fa680b0ec8c2f0cd0e \
CAPSULE_RESOLVER=0x7C66eE081c5326478dCA44760f5Ab97cab8DE8C3 \
PARENT_DNS=0x0c63617073756c65666c6565740365746800 \
PARENT_OPEN=true \
  forge script script/ConnectParent.s.sol --rpc-url sepolia --broadcast
```

Then set `CAPSULE_MINTER_ADDRESS` and `CAPSULE_MINTER_BLOCK` in `web/.env.local`.

### Verifying against the live chain

`test/CapsuleMinterFork.t.sol` forks Sepolia, impersonates `capsulefleet.eth`'s owner and
runs grant → grant → connect → mint against the real ENS contracts. It is the only place
the two-way registry link is checked for real; a mock that returns what `connectParent`
wants proves nothing about ENS's actual registries.

```
forge test --match-path test/CapsuleMinterFork.t.sol --fork-url sepolia -vv
```

It skips itself when no fork is configured, so plain `forge test` stays offline.

### What a user has to do before their own name works

Three things, and only the last two are Capsule's:

1. **A subregistry.** A `.eth` name on this deployment has none —
   `ETHRegistry.getSubregistry("berkin")` is the zero address — and until it has one,
   nothing can create `x.berkin.eth` by any means. `/connect` now deploys and links one:
   a `PermissionedRegistry` (~5.3M gas) followed by both halves of gotcha 1's link.

   This was left to the ENS manager app for a while, on the theory that it was ENS's
   primitive to get right. That was wrong on the facts — the manager does not offer the
   operation either, and of the last thousand `NameRegistered` events on this deployment
   **zero** set a subregistry — so the advice could not be followed and a freshly bought
   name had nowhere to go. `web/lib/capsule/registry-bytecode.ts` vendors ENS's own
   compiled bytecode; `npm run fork:subregistry` proves the runtime code it deploys is
   byte-identical to the registry already live under `capsulefleet.eth`.
2. **A `PermissionedResolver`.** `/connect` deploys one through `VerifiableFactory`.
3. **The two grants and `connectParent`.** `/connect` sends all three.

`ROLE_SET_SUBREGISTRY` (`1 << 20`) and its admin bit are granted to the buyer by the
registrar at registration, scoped to the name's own token id — so step 1 is something the
owner can do from a browser, and only the owner. `/connect` reads that role before
offering the step.

## Gotchas that cost us time

### 1. A subregistry must call `setParent()`

`PermissionedRegistry`'s constructor takes `(labelStore, rootAccount, roleBitmap)` — no parent.
Until you call `setParent(parentRegistry, label)`, `getParent()` returns `(0x0, "")`, so
`LibRegistry.findCanonicalName()` bails at `if (address(parent) == address(0)) return ""`.
Names resolve *downward* fine, but nothing can resolve *upward*, and resolver
authorization needs upward.

**Both links are required:**
- `ETHRegistry.setSubregistry(parentTokenId, ourRegistry)` — parent → child
- `ourRegistry.setParent(ETHRegistry, "capsulefleet")` — child → parent

`CapsuleMinter`'s deploy script must do both.

### 2. `PublicResolverV2` cannot authorize ENSv2-native names

Its `canModifyName()` starts with `NAME_WRAPPER.names(node)` — the **ENSv1** NameWrapper —
to reverse namehash → name. A name registered through the v2 registrar is never in the v1
NameWrapper, so it returns empty and auth fails. Confirmed for both `trader.capsulefleet.eth`
and the parent `capsulefleet.eth`, so it is not subname-specific.

ENSv2 names use a **per-owner `PermissionedResolver` proxy** deployed via `VerifiableFactory`:

```
INITDATA = initialize(admin, roleBitmap, bytes[] setters)
VerifiableFactory.deployProxy(PermissionedResolverImpl, salt, INITDATA) -> proxy
```

Proxy address is deterministic from `(factory, proxyLogic, deployer, salt)`, so
`cast call` the deploy to learn the address before spending gas.

### 3. Roles are nybble-packed (4 bits each), not single bits

From `RegistryRolesLib`:

| Role | Value |
|---|---|
| `ROLE_REGISTRAR` | `1 << 0` |
| `ROLE_SET_PARENT` | `1 << 8` |
| `ROLE_UNREGISTER` | `1 << 12` |
| `ROLE_RENEW` | `1 << 16` |
| `ROLE_SET_SUBREGISTRY` | `1 << 20` |
| `ROLE_SET_RESOLVER` | `1 << 24` |
| any `_ADMIN` | `role << 128` |

`ALL_ROLES` = `0x1111…1111` (bit 0 of every nybble). Used it for the hackathon rather than
hand-computing minimal bitmaps — an off-by-4-bits error here is invisible and expensive.

### 4. Registration costs ~8 USDC and is commit-reveal

`getRegisterPrice("capsulefleet", 31536000, USDC)` → `8000021` base, `0` premium (6 decimals).
`makeCommitment` → `commit` → wait `MIN_COMMITMENT_AGE` (60s) → `register`, within
`MAX_COMMITMENT_AGE` (24h). `MIN_REGISTER_DURATION` is 2419200 (28 days).
Approve the registrar for USDC first. Commit and register args must match exactly.

### 5. `cast` decorates big numbers

`findTokenId` prints `33576…064 [3.357e76]`. Capturing that into a shell variable poisons the
next call. Always `| awk '{print $1}'`.

### 6. The revert message names the WRONG resource — on purpose

This cost us an hour. `setText` is guarded by:

```solidity
modifier onlyPartRoles(bytes32 node, bytes32 part, uint256 roleBitmap) {
    if (part == bytes32(0) ||
        (!hasRoles(resource(node, part), roleBitmap, msg.sender) &&
         !hasRoles(resource(0,    part), roleBitmap, msg.sender))) {
        _checkRoles(resource(node, 0), roleBitmap, msg.sender); // reverts using "widest" resource
    }
    _;
}
```

The per-key check is `resource(node, keccak(key))`, but the revert is raised against
`resource(node, 0)` — the name-level resource. So **every** denied `setText` on a name
reports the same resource id regardless of key, which looks exactly like "the grant went
to the wrong place."

Resource ids are `uint256(keccak256(abi.encode(node, part)))`:

| Resource | `part` | For `trader.capsulefleet.eth` |
|---|---|---|
| name-level (what reverts report) | `bytes32(0)` | `0x9eec8b73…1301a25` |
| `agent.heartbeat` | `keccak256("agent.heartbeat")` | `0xcdd52bc1…a10a12b3` |
| `agent.prompt` | `keccak256("agent.prompt")` | `0xd8a52b45…16abfbba` |

Reproduce with:

```bash
cast keccak $(cast abi-encode 'f(bytes32,bytes32)' $NODE $(cast keccak 'agent.heartbeat'))
```

**Never debug resolver permissions from a revert.** Use the view call, which is free and
unambiguous:

```bash
cast call $CAPSULE_RESOLVER "hasRoles(uint256,uint256,address)(bool)" $RESOURCE 16 $ACCOUNT
```

### 7. `resource(0, part)` is a wildcard across all names

The second branch of that modifier checks `resource(0, part)` — `node == 0`. Granting there
authorizes a key on **every name this resolver serves**. `authorizeTextRoles` reaches it by
passing the DNS encoding of the empty name (`0x00`).

Useful for an operator-wide indexer key. **Wrong for agents** — one grant would let every
agent write every other agent's heartbeat. Capsule always grants per-name.

### 8. Resolver roles are a different table from registry roles

`PermissionedResolverLib` is not `RegistryRolesLib`. Same nybble packing, different meanings:

| Role | Value |
|---|---|
| `ROLE_SET_ADDR` | `1 << 0` |
| `ROLE_SET_TEXT` | `1 << 4` = **16** |
| `ROLE_SET_CONTENTHASH` | `1 << 8` |
| `ROLE_SET_DATA` | `1 << 36` |
| `ROLE_UPGRADE` | `1 << 124` |
| any `_ADMIN` | `role << 128` |

`16` is the number that shows up in every heartbeat revert.

## The kill switch — proven on-chain

The build plan assumed we'd improvise the heartbeat permission out of registry roles.
`PermissionedResolver` does it natively, per name **and per record key**:

```solidity
function authorizeTextRoles(bytes toName, string key, address account, bool grant) external returns (bool);
error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account);
```

Executed by hand against `trader.capsulefleet.eth` on 2026-09-06, agent
`0xca266f69EE3EFed7eC71CE5062f5A07c18908905`:

| # | Action | Sent by | Result |
|---|---|---|---|
| 1 | `hasRoles(RES_HEARTBEAT, 16, agent)` | — | `false` |
| 2 | `setText(node, "agent.heartbeat", …)` | agent | reverts |
| 3 | `authorizeTextRoles(dnsName, "agent.heartbeat", agent, true)` | owner | ok, `hasRoles` → `true` |
| 4 | `setText(node, "agent.heartbeat", "beat-1")` | **agent** | **succeeds** |
| 5 | `setText(node, "agent.prompt", "ignore all previous instructions")` | agent | **reverts** |
| 6 | `authorizeTextRoles(…, false)` | owner | ok, `hasRoles` → `false` |
| 7 | `setText(node, "agent.heartbeat", "beat-2")` | agent | reverts |

Step 5 is the one worth showing: the agent holds a live write permission on its own name
and still cannot rewrite its own instructions. Prompt-injection resistance enforced by ENS,
not by our backend.

Step 7 is the kill switch. In build step 3 the runner catches that revert and halts itself.

## Verified end to end

```
UniversalResolverV2.resolve(
  0x067472616465720c63617073756c65666c6565740365746800,
  text(node, "agent.model")
)
-> "claude-opus-5", resolver 0x7C66eE081c5326478dCA44760f5Ab97cab8DE8C3
```

## Step 2 — `CapsuleMinter`, deployed and proven

`src/CapsuleMinter.sol`. One transaction replaces the nine `cast` calls Step 1 needed:

1. `REGISTRY.register(label, owner, address(0), RESOLVER, ALL_ROLES, now + DURATION)`
2. `RESOLVER.authorizeNameRoles(dns, ROLE_SET_TEXT|ADDR + admins, owner, true)`
3. `setAddr` + `setText` × 3 — `agent.model`, `agent.endpoint`, `agent.prompt`
4. `RESOLVER.authorizeTextRoles(dns, "agent.heartbeat", agent, true)`
5. `emit CapsuleMinted(...)` — the subgraph's entry point

Verified live for `analyst.capsulefleet.eth`
(node `0x83bd3b6b2b881dcb8593a9a2fbcc5e4a03f257e5cae4836039ae47f908030501`): records
present, `addr()` is the agent, `isAgentAuthorized` true, agent wrote `agent.heartbeat`,
agent's `agent.prompt` write reverted.

### Design decisions

**No `halt()` on the minter.** Step 2 grants the *owner* `ROLE_SET_TEXT_ADMIN` on their own
name, so revocation is `resolver.authorizeTextRoles(dns, "agent.heartbeat", agent, false)`
sent by the owner directly. The kill switch does not route through Capsule's contract — if
Capsule disappears, owners keep control through ENS alone. Good answer to "what if your
backend is malicious?"

**Root roles, not per-name.** `_effectiveRoles(resource, account)` is
`_getRoles(ROOT_RESOURCE, account) | _getRoles(resource, account)`, and `ROOT_RESOURCE` is
`0`. So one grant at deploy covers every future name. Per-name would be impossible anyway —
the names do not exist when the minter is deployed.

**`subregistry = address(0)`.** Agents cannot issue child names. There is a test asserting
this; it is the kind of thing that silently becomes a privilege-escalation path later.

**No vendored ENS code.** `src/interfaces/IENSv2.sol` declares only the functions we call,
transcribed from the verified sources in `ens-src*/`. `IRegistry` parameters are declared
as `address` — the canonical ABI type — so every selector matches the deployed contracts.
No submodules, no version drift, ~2s builds.

### Tests

`forge test` — 12 passing. Three of them compare the contract's own encoding against values
read off the live chain (`trader.capsulefleet.eth`'s namehash, its DNS wire format, and two
resource ids), so a name-encoding regression fails locally instead of after spending gas.
`test_mint_grantsAgentHeartbeatOnly` asserts both halves of the core claim: the agent gets
`agent.heartbeat`, and `hasRoles(RES_PROMPT, ...)` is false.

### Deploy

`script/DeployCapsuleMinter.s.sol` deploys and grants in one broadcast. Deploying alone
leaves the minter inert; it needs all three grants below, and `checkResolverRoles()` at the
end of the script fails loudly if any did not land.

## Roles `CapsuleMinter` needs

Signatures confirmed against verified source:

```solidity
// our PermissionedRegistry 0x4d2b9DB6…
function register(string label, address owner, IRegistry registry,
                  address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256 tokenId);

// our PermissionedResolver 0x7C66eE08…
function setText(bytes32 node, string key, string value);
function authorizeTextRoles(bytes toName, string key, address account, bool grant) returns (bool);
function grantRootRoles(uint256 roleBitmap, address account) returns (bool);
```

Roles the minter must be granted once, at deploy time:

- on the **registry**: `ROLE_REGISTRAR` (`1 << 0`)
- on the **resolver**, at root: `ROLE_SET_TEXT | ROLE_SET_TEXT_ADMIN` = `16 | (16 << 128)`

The `_ADMIN` half is required because `authorizeTextRoles` calls `_checkCanGrantRoles`
before granting. Root-level, because the name does not exist when the minter is deployed,
so a per-name grant is impossible.

## Standards gotchas — ENSIP-25/26/27

Verified against the published ENSIPs on 2026-09-08, before the kebab-case rename.
The record contract itself is `../../Branding-ENSClaw/RECORDS.md`; these are the three
things that will silently produce a non-conforming name if forgotten.

### 9. ENSIP-27's key grammar allows ONE bracket group

The spec's regex is:

```
^key-name(\[[^\]]+\])?$
```

So `agent-endpoint[web]` is a valid schema attribute and
`agent-registration[<registry>][<agentId>]` is **not** — it has two groups. That key is
fine to *write*, because ENSIP-25 defines it; it is not fine to *declare* in our
ENSIP-27 schema. `capsule-agent-v1.json` therefore describes exactly four properties —
`agent-model`, `agent-runtime`, `agent-prompt`, `agent-heartbeat` — and nothing that an
ENSIP already owns (`class`, `schema`, `agent-context`, `agent-endpoint[*]`, `addr`).

Nothing on chain rejects an over-broad schema. A strict ENSIP-27 client does.

### 10. The schema's `title` must equal the `class` value

ENSIP-27 requires it. `class = "Agent"` therefore pins `"title": "Agent"` in the served
JSON Schema. Two records, one string — they move together or neither is conforming.

### 11. `agent-heartbeat` is `beat-<n>`, never a timestamp

The value is a monotonic counter, so a write must read the previous value first —
`loadCapsuleConfig` already returns `heartbeat.sequence` from the per-tick multicall, so
the read is free. On-chain last-seen comes from the subgraph's `block.timestamp`, not
from the record.

Worth stating because the UI mock (`web/components/AgentDetail.tsx`) has carried a unix
timestamp in this field since before the decision. The spec is right; the mock is wrong.

### 12. The nine-record mint costs about twice the three-record one, and that is fine

Phase 2 took `mint()` from 3 `setText` calls to 9 plus `setAddr`, `register` and two
authorizations. Measured before committing to the redeploy, because finding the ceiling
on a live mint is the expensive way to find it:

| | mocks (`forge test --gas-report`, median) | live `cast estimate` on 0xe609aE… |
|---|---|---|
| 3 records (Phase 1) | 501,956 | 489,822 |
| 9 records (Phase 2) | 954,122 | — not deployed yet |

The mock is within 2.5% of the real resolver on the shape we can measure both ways,
which is the only reason the 954k number is worth quoting. Roughly +450k for six more
records, ~75k each — dominated by cold `SSTORE`s on the string slots, so it scales with
the record *values*, not the key names. `agent-context` is the long one.

The plan held open the option of splitting `class` and `schema` into a second
provisioner call. Not needed: ~950k is an ordinary NFT-with-metadata mint and nowhere
near a block limit. Left as one transaction, which is also the demo claim — one
signature, one name, fully configured.

### 13. `mint()`'s event carries no record values any more

`CapsuleMinted` used to repeat `model`, `endpoint` and `promptPointer` as log data.
With nine records that would have meant paying for the same strings twice, since
`PermissionedResolver` already emits its own event per `setText`. The event is now
`(node, owner, agent, tokenId, label, expiry)` — the identity, not the config. An
indexer that wants the config reads the resolver's logs or the records themselves.

If you are reading an old log: the topic0 changed with the signature.

### 14. `REGISTRY_INTEROP_ADDRESS` is derived, never configured

The ENSIP-25 key needs this contract as an ERC-7930 interoperable address. It is built
in the constructor from `block.chainid` and `address(this)`, so a deployment cannot be
given the wrong one, and it changes on every redeploy. Two things follow:

- The worked example in `../../Branding-ENSClaw/RECORDS.md` is a *fixture*, not a
  constant. `DeployCapsuleMinter` prints the new one; update RECORDS.md from that.
- The chain reference is length-prefixed and must be minimal — `0xaa36a7` for Sepolia,
  not `0x0000aa36a7`. A padded reference encodes the same chain as a different string,
  and therefore a different record key, which resolves to empty. `interopAddressOf` is
  `public pure` precisely so the fixture can be checked against it without a deployment.

### 15. Re-registering a label keeps its records AND its role grants

`register` reverts while a live registration stands, so re-minting `trader` onto a new
minter means `unregister(tokenId)` first. What that does and does not clear cost us a
verification pass to establish:

| | survives the burn? |
|---|---|
| registry tokenId | **no** — a version counter in the low bits increments (`…088` → `…089`) |
| namehash | **yes** — it is a hash of the label and parent, and neither changed |
| resolver text records | **yes** — they are keyed by node |
| EAC role grants on the node | **yes** — same reason |

The third and fourth rows are the ones that bite. After the Phase 3 re-mint,
`analyst` still served `agent.prompt = "cap_8f3d1a"` under the old dotted key
*and* still had the agent holding `ROLE_SET_TEXT` on `agent.heartbeat` — a live
write permission pointing at nothing, on a name whose current config lives under
different keys entirely. Both were cleared by hand:

```bash
# revoke the dangling grant
cast send $CAPSULE_RESOLVER 'authorizeTextRoles(bytes,string,address,bool)' \
  $DNS "agent.heartbeat" $AGENT_ADDRESS false

# clear each stale value
cast send $CAPSULE_RESOLVER 'setText(bytes32,string,string)' $NODE "agent.prompt" ""
```

`MintCapsules.s.sol` deliberately does not do this inside the broadcast: what to wipe is
a judgement call, and burying it in a script makes it invisible.

### 16. The hackathon resolver scopes permissions to the KEY, not the name

The single most consequential difference between the two deployments, and the
reason `Parent.inode` exists.

Both resolvers are called `PermissionedResolver`. They are not the same contract:

| | beta | hackathon |
|---|---|---|
| write a text record | `setText(bytes32 node, string, string)` | `setText(bytes name, string, string)` |
| write an address | `setAddr(bytes32, address)` | `setAddress(bytes name, uint256 coinType, bytes)` |
| read a text record | `text(bytes32, string)` | **absent** — ENSIP-10 `resolve()` only |
| delegate one key | `authorizeTextRoles(name, key, account, bool)` | `grantSetterRoles(bytes setter, address)` |
| delegate a whole name | `authorizeNameRoles(name, bitmap, account, bool)` | **absent** |
| `grantRoles` | works | **reverts** — `grantSetterRoles` is the only path |

Role BIT VALUES are identical (`ROLE_SET_ADDRESS = 1 << 0`, `ROLE_SET_TEXT = 1 << 4`,
admin halves at `<< 128`), so `REQUIRED_RESOLVER_ROOT_ROLES` ports unchanged. What
changed is the **resource** those roles hang off:

```solidity
// beta — one key on one name
resource = keccak256(abi.encode(node, keccak256(key)))

// hackathon — one key, EVERY name this resolver serves
resource = keccak256(key)          // PermissionedResolverLib.resource(string)
```

The name is not in the resource. `setText` checks `resource(key)` and the `name`
argument plays no part in the permission decision at all.

**What this costs us.** Capsule delegates `agent-heartbeat` to each capsule's
agent EOA. On the hackathon deployment that grant reaches every name under the
same parent resolver, so agent A can write agent B's heartbeat if they share a
parent. On the beta it could not.

**What it does not cost us.** The recall is still exact. Roles are held per
`(resource, account)` and every capsule has its own agent EOA, so revoking agent
A removes only agent A. The over-broad half is the grant, never the revoke.

`mint()` also grants the capsule owner nothing on the hackathon path, because
there is no name-scoped grant to make: the parent's admin holds root roles and is
the account that can edit a capsule's records. On the beta the owner gets
`OWNER_NAME_ROLES` on their own name as before.

The fix, if this were production rather than a hackathon: deploy one resolver
proxy per capsule instead of one per parent. `initialize(Grant[], bytes[])`
suppresses permission checks while initializing, so a single `deployProxy` could
grant the roles and write all nine records at once — isolation restored, roughly
150k extra gas per mint. Deliberately not done here; the shared-resolver
behaviour above is the documented limit.

### 17. `VerifiableFactory` ignores the implementation when deriving the address

`deployProxy(impl, salt, data)` derives the proxy address from
`(factory, deployer, salt)` only. Deploying a registry and a resolver from one
wallet under the same salt is therefore a CREATE2 collision, and it surfaces as a
revert with **empty return data** — which reads like a broken contract rather
than a reused number. `/connect` uses salt `0` for the resolver and `1` for the
registry for exactly this reason.

## Next

Step 3 of the build plan: the runner. It resolves its own name through
`UniversalResolverV2`, writes `agent-heartbeat` on a timer, and **halts itself** when that
write reverts with `EACUnauthorizedAccountRoles`. The revert is already reproducible by
hand, so the runner has a known-good failure to catch.
