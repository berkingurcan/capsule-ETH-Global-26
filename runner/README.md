# Capsule runner

The agent. Give it one thing — its own ENS name — and it finds out what it is
from the records under that name, checks every tick that it is still allowed to
be that, and shuts itself down when the answer becomes no.

```
CAPSULE_NAME=analyst.capsulefleet.eth
        ↓
addr                     who this agent is        → refuses to boot if it is not us
agent-model              which brain              → swap it on chain, no redeploy
agent-endpoint[capsule]  where the prompt lives
agent-prompt             cap_8f3d1a               → a pointer; the body stays off chain
agent-heartbeat          the one key it may write → beat-1, beat-2, beat-3…
```

## What the agent knows about itself

The supervisor reads a whole identity off the chain and, until recently, told the
model one part of it: the prompt body. Asked "what is your wallet address", a
correctly provisioned capsule answered *"I do not have an EVM wallet or wallet
address assigned to me"* — in good faith, because from inside the gateway that
was the only observation available. A working capsule and an unprovisioned one
gave the identical answer, which makes the answer worthless as evidence.

So `~/.openclaw/workspace/AGENTS.md` is composed rather than copied
(`src/persona.ts`). Three sections, in this order and never another:

```
# Capsule identity     name · addr · namehash · resolver · model · prompt ref
                       and what the wallet is for: the supervisor holds the key,
                       spends it on agent-heartbeat, and nothing else

## Live status         authorized · balance · beat-<n> · ticks and beats this run
                       rewritten every tick, no restart

## Your instructions   the body of agent-prompt, verbatim
```

The order is the security property. `agent-prompt` is the only part of that file
an attacker can reach — it arrives over the network from a pointer the owner
controls — and it lands last, under a heading that names it, below facts the
supervisor stated first. The resolver already refuses to let an agent rewrite its
own `agent-prompt`; this is the same boundary written where the model can see it.

The file is written through a temporary and renamed, because the tick loop
rewrites it while the gateway is reading it, and the reader in a torn-write
window is a language model being told who it is. The balance inside it is
sampled on its own slower cadence — it only moves when the agent beats or its
owner tops it up, and a beat forces a fresh read.

**The same facts reach the child's environment** — `CAPSULE_NAME`,
`CAPSULE_AGENT_ADDRESS`, `CAPSULE_NODE`, `CAPSULE_RESOLVER`, `CAPSULE_CHAIN_ID` —
for tools and shell commands rather than prose. Every one is public: three are
text records anybody can resolve and the fourth is the address they point at.

`AGENT_KEY` is not among them and never will be. The agent cannot sign anything;
the supervisor signs `agent-heartbeat` on its behalf and nothing else. Note the
shape of that guard: `buildOpenClawEnv` builds the child's environment from
nothing rather than filtering the supervisor's, so a new secret is excluded by
default instead of having to be remembered. `dev/gateway-smoke.ts` asserts it,
including a scan for anything shaped like a 32-byte key.

`CAPSULE_RPC_URL` is the one exception that is opt-in. The supervisor's own
`SEPOLIA_RPC_URL` usually carries a provider key in its path, which makes it a
credential wearing a URL's clothes; handing it to a process that executes
model-chosen tools would undo the paragraph above. Set `CAPSULE_AGENT_RPC_URL` to
an endpoint you are willing to have the agent spend, or leave it unset and let
the agent read its balance out of its own status block.

**Two cadences.** Every `TICK_SECONDS` the runner asks whether it is still
authorized — an `eth_call`, free, same modifier and same revert as the write.
Every `HEARTBEAT_SECONDS` it writes `beat-<n>` for real.

The check and the record are different jobs. A free call proves the permission
is live to the process holding it and to nobody else; the write is the part an
observer with nothing but the chain can read. Probing in between is what keeps a
revocation caught in one tick instead of one heartbeat interval.

So the agent needs a funded wallet — 66,420 gas a beat, measured. It is still
the least privileged key in the system: one text record, on one name. An empty
wallet degrades it to probe-only rather than stopping it, and says so in the log
every time it tries, because a heartbeat that stops advancing for want of gas
looks exactly like a revoked one.

## Environment

Copy `.env.example` to `.env`. Every value is required except the last two, and
there are no fallbacks — a runner that quietly substitutes a value it was not
given is one that fails in a way that looks like a revocation.

| Variable | Notes |
|---|---|
| `SEPOLIA_RPC_URL` | |
| `AGENT_ADDRESS` | must match `AGENT_KEY`, and match `addr` on the name |
| `AGENT_KEY` | the agent's key — deliberately the weakest in the system |
| `CAPSULE_NAME` | e.g. `analyst.capsulefleet.eth` |
| `TICK_SECONDS` | probe cadence. Default 30, minimum 5 |
| `HEARTBEAT_SECONDS` | write cadence. Default 28800 (3/day); `60` for a demo. Must be >= `TICK_SECONDS` |
| `CAPSULE_AGENT_RPC_URL` | an endpoint the *agent* may spend, reaching the gateway as `CAPSULE_RPC_URL`. Never `SEPOLIA_RPC_URL` — see below |
| `CAPSULE_ENDPOINT_OVERRIDE` | dev only, announced in the logs when set |

## Commands

| | |
|---|---|
| `npm start` | the runner |
| `npm run preflight` | RPC, chain, identity, and whether it can afford a beat |
| `npm run config` | the whole capsule, as read off the name |
| `npm run resolve [key]` | one text record |
| `npm run prompt` | fetch the prompt and print nothing that matters |
| `npm run heartbeat` | write one beat on chain, by hand. The loop does this on its own now |
| `npm run dev:prompt-server` | local stand-in for the prompt service |
| `npm run typecheck` | |

## Local run

```bash
npm run dev:prompt-server                       # terminal 1
CAPSULE_ENDPOINT_OVERRIDE=http://localhost:8787 \
  TICK_SECONDS=15 HEARTBEAT_SECONDS=60 npm start   # terminal 2
```

Every beat is a real Sepolia transaction. `HEARTBEAT_SECONDS=60` for an hour is
60 beats, about 0.004 ETH at 1 gwei — cheap, but not free, and the agent wallet
is the one paying.

## Docker

```bash
docker build -t capsule-runner .

docker run --init --rm --env-file .env \
  -e TICK_SECONDS=5 -e HEARTBEAT_SECONDS=60 \
  -e CAPSULE_ENDPOINT_OVERRIDE=http://host.docker.internal:8787 \
  capsule-runner
```

`host.docker.internal` is how a container on macOS reaches a service on the
host. Fly machines are `amd64`; on Apple silicon add `--platform linux/amd64`
before pushing an image there.

## The kill test

The demo, rehearsed. Owner transactions run from `../contracts`.

```bash
cd ../contracts && source .env
NODE=0x83bd3b6b2b881dcb8593a9a2fbcc5e4a03f257e5cae4836039ae47f908030501
DNS=0x07616e616c7973740c63617073756c65666c6565740365746800
```

**1. Start the runner** (container or `npm start`) and watch it tick.

**2. Revoke, as the owner.**

```bash
cast send --rpc-url $SEPOLIA_RPC_URL --private-key $PRIVATE_KEY \
  $CAPSULE_RESOLVER "authorizeTextRoles(bytes,string,address,bool)" \
  $DNS "agent-heartbeat" $AGENT_ADDRESS false
```

**3. Within one tick:**

```
🔴 denied     setText(agent-heartbeat) refused by the resolver
🔴 confirmed  no ROLE_SET_TEXT on agent-heartbeat, and none via the wildcard
🔴 halted     analyst.capsulefleet.eth · N ticks, M beats this run · last beat-3
runner halted
```

The probe is what catches it, so this lands within one tick even if the next
paid beat was hours away.

**4. Check the exit code.** It must be `0`.

```bash
docker inspect <container> --format '{{.State.ExitCode}}'
```

A revoked agent did not crash — it did the thing it was built to do. Exiting
non-zero would make Fly restart it into a loop, which is the difference between
a kill switch and a crash.

**5. Grant it back** — the same command with `true` — and start it again. The
kill switch has to be reversible or the fleet dashboard is a one-way door.

## The empty-wallet test

The other half of the kill test, and the one nobody rehearses. A revoked agent
and a broke agent both stop writing `agent-heartbeat`, so from the chain alone
they are the same event. Only the log tells them apart, so the log has to be
right.

Point the runner at a funded name with an unfunded key — any fresh keypair whose
address is *not* `addr` on the name will fail the boot identity check first, so
instead drain the agent, or run against a name minted to a key you have emptied.
Expect, on the beat and not on the probe:

```
⚠️  12:00:30  beat unaffordable — the permission is intact, the wallet is not
   gas        0.000000 ETH · ~0 beats at 1.04 gwei — under 100. Fund 0xca26…
✅ 12:00:31  tick 3 · authorized · 0.4s
```

Three things must be true. It says **unfunded**, never "denied". It keeps
ticking — the probe is free, so authorization is still being checked every tick
and a revocation would still be caught. And it does not spend the failure
budget, so it never exits: a top-up is meant to be a top-up, not a redeploy.

`npm run preflight` fails outright at zero affordable beats, which is the same
fact caught earlier.

## Swapping the prompt while it runs

`cap_7b21e9` is a second persona in the dev prompt store. Dry-run first; a
denied write through `cast send` reports only "failed to estimate gas".

```bash
cast call --rpc-url $SEPOLIA_RPC_URL --from $ADDRESS \
  $CAPSULE_RESOLVER "setText(bytes32,string,string)" $NODE "agent-prompt" "cap_7b21e9"
```

Then send it, and within one tick:

```
🔄 prompt cap_7b21e9 · 284 chars, … — this is a different agent now
```

Same container, different agent, no redeploy.

## Debugging permissions

Never from the revert. `setText` checks the per-key resource but raises against
the name-level one, so every denied write on a name reports the same resource
id whichever key you were actually refused on. Ask the role table instead:

```bash
RES=$(cast keccak $(cast abi-encode 'f(bytes32,bytes32)' $NODE $(cast keccak 'agent-heartbeat')))
cast call $CAPSULE_RESOLVER "hasRoles(uint256,uint256,address)(bool)" $(cast to-dec $RES) 16 $AGENT_ADDRESS
```

`16` is `ROLE_SET_TEXT` on the resolver's table.
