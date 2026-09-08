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
agent-heartbeat          the one key it may write → and the one it is probed against
```

**No transactions.** The authorization probe is an `eth_call`, so an agent needs
a key and nothing else — no funded wallet, and no funding pipeline behind it.
The trade is that `agent-heartbeat` never advances on chain, so there is no
on-chain last-seen; the owner's revocation event carries the fact that matters.

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
| `TICK_SECONDS` | default 30, minimum 5 |
| `CAPSULE_ENDPOINT_OVERRIDE` | dev only, announced in the logs when set |

## Commands

| | |
|---|---|
| `npm start` | the runner |
| `npm run preflight` | RPC, chain, identity, balance |
| `npm run config` | the whole capsule, as read off the name |
| `npm run resolve [key]` | one text record |
| `npm run prompt` | fetch the prompt and print nothing that matters |
| `npm run heartbeat` | write one beat on chain. Manual tool; the loop never calls it |
| `npm run dev:prompt-server` | local stand-in for the prompt service |
| `npm run typecheck` | |

## Local run

```bash
npm run dev:prompt-server                       # terminal 1
CAPSULE_ENDPOINT_OVERRIDE=http://localhost:8787 \
  TICK_SECONDS=15 npm start                     # terminal 2
```

## Docker

```bash
docker build -t capsule-runner .

docker run --init --rm --env-file .env \
  -e TICK_SECONDS=5 \
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
🔴 halted     analyst.capsulefleet.eth · N ticks this run · 0 transactions
runner halted
```

**4. Check the exit code.** It must be `0`.

```bash
docker inspect <container> --format '{{.State.ExitCode}}'
```

A revoked agent did not crash — it did the thing it was built to do. Exiting
non-zero would make Fly restart it into a loop, which is the difference between
a kill switch and a crash.

**5. Grant it back** — the same command with `true` — and start it again. The
kill switch has to be reversible or the fleet dashboard is a one-way door.

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
