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

## The kill switch — better than planned

The build plan assumed we'd improvise the heartbeat permission out of registry roles.
`PermissionedResolver` does it natively, per name **and per record key**:

```solidity
function authorizeTextRoles(bytes toName, string key, address account, bool grant) external returns (bool);
error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account);
```

So: grant the agent write access to `agent.heartbeat` only. Owner keeps `agent.prompt`,
`agent.model`, etc. Revoke → the agent's next heartbeat reverts with
`EACUnauthorizedAccountRoles` → the runner halts itself.

This is a real ENSv2 primitive, not a workaround. Update `build-plan.html` and
`architecture.html` to reflect it.

## Verified end to end

```
UniversalResolverV2.resolve(
  0x067472616465720c63617073756c65666c6565740365746800,
  text(node, "agent.model")
)
-> "claude-opus-5", resolver 0x7C66eE081c5326478dCA44760f5Ab97cab8DE8C3
```

## Next

Step 2 of the build plan: `CapsuleMinter.sol` + the heartbeat role.
