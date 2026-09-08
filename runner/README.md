# Capsule runner

The supervisor. Give it one thing — its own ENS name — and it finds out what it is
from the records under that name, starts the agent those records describe, checks
continuously that it is still allowed to be that, and shuts the agent down when the
answer becomes no.

It is not the agent. The agent is an [OpenClaw](https://docs.openclaw.ai) gateway
talking to the owner's Telegram bot. This process decides whether that gateway may
exist, and configures it from the chain.

```
CAPSULE_NAME=analyst.capsulefleet.eth
        ↓
addr                     who this agent is       → refuses to boot if it is not us
class                    Agent                      ENSIP-27
schema                   what the keys below mean   ENSIP-27
agent-context            what this agent is for     ENSIP-26
agent-endpoint[capsule]  where the control plane is  ← prompt + sealed credentials
agent-endpoint[web]      https://t.me/…             ENSIP-26, the bot
agent-model              which brain             → swap it on chain, no redeploy
agent-runtime            openclaw
agent-prompt             cap_8f3d1a              → a pointer; the body stays off chain
agent-heartbeat          the one key it may write → and the one it is probed against
```

Every key is kebab-case because ENSIP-27 requires it of schema attributes, and the
parameterised ones use brackets because ENSIP-26 defines them that way. The strings
live in [`src/records.ts`](src/records.ts) and nowhere else — see the module comment
for why a typo there is the most expensive kind of bug in this system.

## Two cadences

| | | |
|---|---|---|
| `TICK_SECONDS` | 30 | A free `eth_call` asking the resolver whether the write would be allowed. This is what makes a recall look instant. |
| `HEARTBEAT_SECONDS` | 28800 | A real transaction writing `agent-heartbeat`. Three a day. This is the part anyone else can see. |

The probe alone would be cheaper and would still catch the kill switch. It would
also leave nothing behind, and a liveness signal only the agent can observe is not
one — the dashboard could not tell a running agent from a crashed one, and the
subgraph would have nothing to index between a mint and a revocation.

Writing at the probe rate is the other wrong answer: measured at 48,423 gas, one
write every 30 seconds is ~54 ETH/year per agent at 10 gwei on mainnet. Three a day
is ~0.05.

**For a demo, set `HEARTBEAT_SECONDS=60`** so the counter moves on camera. It is one
environment variable, and saying so is a better answer than a dashboard that does not
appear to do anything.

## Environment

Copy `.env.example` to `.env`. Every value is required except the last few, and there
are no fallbacks — a runner that quietly substitutes a value it was not given is one
that fails in a way that looks like a revocation.

| Variable | Notes |
|---|---|
| `SEPOLIA_RPC_URL` | |
| `AGENT_ADDRESS` | must match `AGENT_KEY`, and match `addr` on the name |
| `AGENT_KEY` | the agent's key — deliberately the weakest in the system |
| `CAPSULE_NAME` | e.g. `analyst.capsulefleet.eth` |
| `TICK_SECONDS` | default 30, minimum 5 |
| `HEARTBEAT_SECONDS` | default 28800, minimum 30 |
| `OPENCLAW_HOME` | default `/home/node/.openclaw`, set in the image |
| `OPENCLAW_BIN` | default `openclaw` |
| `CAPSULE_ENDPOINT_OVERRIDE` | dev only, announced in the logs when set |

**The agent needs gas.** It pays for its own heartbeats, so the provisioner funds each
EOA at mint. The boot log prints the balance and warns below 0.002 ETH; a heartbeat
that fails for want of gas is a transient failure, never a revocation, and `halt.ts`
draws that line.

## What the supervisor writes

Nothing about the gateway is configured by hand. On boot, and again whenever a record
changes, it renders:

| File | From |
|---|---|
| `~/.openclaw/openclaw.json` | `agent-model`, the Telegram bot token and the DM allowlist |
| `~/.openclaw/workspace/AGENTS.md` | the prompt body, fetched over a signed request |
| `~/.openclaw/workspace/IDENTITY.md` | the name, `agent-context`, and what the agent may not change |

Then it starts `openclaw gateway` as a child process. The rendered configuration is
digested, so re-reading unchanged records does not bounce a live bot; a changed record
restarts it within one tick.

`dmPolicy` is `allowlist` and the supervisor **refuses to start** with an empty
`allowFrom`. An agent whose bot anyone can DM is a prompt-injection surface reachable
from a search box, and ENS cannot defend against that — the injected instruction never
touches a record.

## Where the credentials come from

Two secrets the chain must never carry: the owner's Telegram bot token and a model
provider API key. Both arrive over `GET /runtime` on the control plane, authorised
exactly the way the prompt fetch is — the runner signs, the service recovers the
signer and asks ENS whether the name claims that address.

**No credential is issued to an agent.** The key it signs with is the identity ENS
already published. The domain separator differs from the prompt fetch on purpose: the
same key signs both inside the same 60-second window, and a signature captured from a
prompt request must not open the endpoint that hands out a bot token.

## Commands

| | |
|---|---|
| `npm start` | the runner |
| `npm run build` | compile to `dist/`, as the image does |
| `npm run preflight` | RPC, chain, identity, balance |
| `npm run config` | the whole capsule, as read off the name |
| `npm run resolve [key]` | one text record |
| `npm run prompt` | fetch the prompt and print nothing that matters |
| `npm run heartbeat` | write one beat by hand. The loop has its own schedule |
| `npm run dev:prompt-server` | local stand-in for the control plane, both routes |
| `npm run typecheck` | |

## Local run

```bash
npm run dev:prompt-server                       # terminal 1
CAPSULE_ENDPOINT_OVERRIDE=http://localhost:8787 \
  TICK_SECONDS=15 HEARTBEAT_SECONDS=60 npm start  # terminal 2
```

The dev server serves placeholder credentials. For a bot that actually answers, set
`DEV_TELEGRAM_BOT_TOKEN`, `DEV_MODEL_API_KEY` and `DEV_TELEGRAM_ALLOW_FROM` (your own
numeric Telegram user id — @userinfobot will tell you it) before starting it.

## Docker

The image is `FROM ghcr.io/openclaw/openclaw`, with the supervisor compiled to plain
JavaScript and copied in as PID 1. It is not `node:alpine` any more: tsx pulls in
esbuild, and a musl-linked binary does not run on the gateway's glibc.

```bash
docker build -t capsule-runner .

docker run --init --rm --env-file .env \
  -e TICK_SECONDS=5 -e HEARTBEAT_SECONDS=60 \
  -e CAPSULE_ENDPOINT_OVERRIDE=http://host.docker.internal:8787 \
  capsule-runner
```

`host.docker.internal` is how a container on macOS reaches a service on the host. Fly
machines are `amd64`; on Apple silicon add `--platform linux/amd64` before pushing an
image there.

## The kill test

The demo, rehearsed. Owner transactions run from `../contracts`.

```bash
cd ../contracts && source .env
NODE=0x83bd3b6b2b881dcb8593a9a2fbcc5e4a03f257e5cae4836039ae47f908030501
DNS=0x07616e616c7973740c63617073756c65666c6565740365746800
```

**1. Start the runner** (container or `npm start`), message the bot on Telegram, and
watch it answer.

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
🔴 stopped    openclaw gateway
🔴 halted     analyst.capsulefleet.eth · N ticks, M heartbeats this run
runner halted
```

Message the bot again. It does not answer — the gateway is stopped before the runner
exits, because a kill switch that does not reach the surface the owner can see is not
a kill switch.

**4. Check the exit code.** It must be `0`.

```bash
docker inspect <container> --format '{{.State.ExitCode}}'
```

A revoked agent did not crash — it did the thing it was built to do. Exiting non-zero
would make Fly restart it into a loop, which is the difference between a kill switch
and a crash.

**5. Grant it back** — the same command with `true` — and start it again. The kill
switch has to be reversible or the fleet dashboard is a one-way door.

## Swapping the prompt while it runs

`cap_7b21e9` is a second persona in the dev prompt store. Dry-run first; a denied write
through `cast send` reports only "failed to estimate gas".

```bash
cast call --rpc-url $SEPOLIA_RPC_URL --from $ADDRESS \
  $CAPSULE_RESOLVER "setText(bytes32,string,string)" $NODE "agent-prompt" "cap_7b21e9"
```

Then send it, and within one tick:

```
🔄 prompt cap_7b21e9 · 284 chars, … — this is a different agent now
   openclaw   configuration changed, restarting the gateway
```

Same container, different agent, no redeploy. The next Telegram message gets the new
persona.

## Debugging permissions

Never from the revert. `setText` checks the per-key resource but raises against the
name-level one, so every denied write on a name reports the same resource id whichever
key you were actually refused on. Ask the role table instead:

```bash
RES=$(cast keccak $(cast abi-encode 'f(bytes32,bytes32)' $NODE $(cast keccak 'agent-heartbeat')))
cast call $CAPSULE_RESOLVER "hasRoles(uint256,uint256,address)(bool)" $(cast to-dec $RES) 16 $AGENT_ADDRESS
```

`16` is `ROLE_SET_TEXT` on the resolver's table.

**One consequence of the rename:** names minted before 2026-09-08 authorised
`agent.heartbeat`, with a dot. This runner writes `agent-heartbeat`, which is a
different resource, so it will be refused and will report a revocation that never
happened. Those names are not migrated — they are testnet names and get re-minted.
