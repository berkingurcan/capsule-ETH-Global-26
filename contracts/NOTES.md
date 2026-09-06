# Capsule — ENSv2 Sepolia notes

Step 1 of the build plan: **mint one subname by hand and read it back.** Complete.
Everything below was verified against the live Sepolia beta, not from docs.

## What exists on-chain

| Thing | Address / value |
|---|---|
| Owner wallet (burner) | `0x9e0283E37bd2f2c6bEFC29b89CF2d86fe5b5fB71` |
| Parent name | `capsulefleet.eth` |
| Our subregistry (`PermissionedRegistry`) | `0x4d2b9DB6b011425F12F271Fa680b0ec8c2f0cd0e` |
| Our resolver (`PermissionedResolver` proxy) | `0x7C66eE081c5326478dCA44760f5Ab97cab8DE8C3` |
| **`CapsuleMinter`** (ours) | `0xe609aE1Cfb8277cE14286428Aa1D0D88A337a362` |
| Parent namehash | `0x036a91f25e11db713abf00b569adb0a03c248d7b9f291430dac6807860d4a6b3` |
| Parent DNS encoding | `0x0c63617073756c65666c6565740365746800` |
| Test agent EOA | `0xca266f69EE3EFed7eC71CE5062f5A07c18908905` |
| First agent name | `trader.capsulefleet.eth` |
| …its namehash | `0x66a9d2f8c0624c05f62f7b4767380c0ed5de24b18e2ac582cb30b03fc9483648` |
| …its DNS-encoded name | `0x067472616465720c63617073756c65666c6565740365746800` |

## ENSv2 Sepolia beta — contracts we call

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

## Next

Step 3 of the build plan: the runner. It resolves its own name through
`UniversalResolverV2`, writes `agent.heartbeat` on a timer, and **halts itself** when that
write reverts with `EACUnauthorizedAccountRoles`. The revert is already reproducible by
hand, so the runner has a known-good failure to catch.
