# Capsule — Contracts

The Solidity side of Capsule: one contract that mints AI agents as ENSv2 subnames.

## The core idea

`CapsuleMinter.sol` turns `label.yourname.eth` into a live agent in one transaction:

1. Register the subname in your name's subregistry
2. Write the agent's records (model, runtime, prompt pointer, Telegram, …)
3. Give **you** control of the name
4. Give the agent write access to **exactly one record: `agent-heartbeat`**

That last point is the security model. The agent can prove it is alive but **cannot
rewrite its own instructions** — enforced by the ENS resolver, not by our backend.

## Architecture: one minter, many names

- The minter holds **no parent name**. Any `.eth` name can connect via `connectParent`.
- A name connects **once** — registry, resolver, DNS name stored on chain. After that,
  `mint()` takes only the registry; nothing can be pointed at a mismatched combo.
- **No `halt()` in the contract.** The kill switch is the owner revoking the agent's
  one permission directly on the resolver. If Capsule disappears, owners keep control
  through ENS alone.

## Layout

| Path | What it is |
|---|---|
| `src/CapsuleMinter.sol` | the only contract — mint, connect, views |
| `src/interfaces/IENSv2.sol` | minimal local interfaces for the ENSv2 beta |
| `script/` | Foundry deploy scripts |
| `test/` | unit tests + a live-chain fork test |
| `ens-src*/` | ENS's verified sources, read-only reference (never compiled) |
| `abi/` | ABIs of third-party ENS contracts we call |

No vendored ENS code. Only the functions we call are declared in `IENSv2.sol`,
transcribed from the verified sources in `ens-src*/`. Builds in ~2 seconds.

## Deploy scripts

| Script | When |
|---|---|
| `script/DeployCapsuleMinter.s.sol` | once per chain — deploy the minter |
| `script/ConnectParent.s.sol` | once per name — grants roles + `connectParent` |
| `script/MintCapsules.s.sol` | mint the four demo capsules |

The deploy prints the minter address and its ERC-7930 registry id. Put the address — and
the deploy block from `broadcast/` — into `web/.env.local`.

## Commands

```
forge build          # compile
forge test           # 12 tests, fully offline
forge test --match-path test/CapsuleMinterFork.t.sol --fork-url sepolia -vv   # live-chain proof
```

The fork test verifies the two-way registry link against real ENS contracts on
Sepolia; everything else runs offline. `forge test` alone never hits the network.

## Live deployment (Sepolia)

| Thing | Address |
|---|---|
| `CapsuleMinter` | `0xE114CAf799f11Ed61Bd44Fc7d498D96Db62bDF51` |
| demo parent | `capsulefleet.eth` (connected, open — anyone may mint) |

## Read `NOTES.md`

The ENSv2 beta rewards reading before writing. `NOTES.md` logs every trap we hit:
role packing, the two-way parent link, which resolver cannot authorize v2 names,
why a revert reports the wrong resource, and more. Read it before changing anything.
