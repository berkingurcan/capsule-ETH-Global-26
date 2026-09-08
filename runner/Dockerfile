# The agent, in a box.
#
# Two programs, one machine. The supervisor is PID 1 — it owns the ENS name, the
# agent key, the permission and the lifetime. OpenClaw is its child, and owns the
# model loop, the tools and the Telegram surface. The base image is the gateway's
# because the gateway is the part with the heavy dependency tree; the supervisor
# is a few hundred lines of TypeScript layered on top of it.
#
# Configuration arrives entirely through the environment at `docker run` — no
# config file, no baked secrets — which is the same shape the provisioner uses
# when it creates a Fly machine over the API in build step 4.
# `~/.openclaw/openclaw.json` is written at runtime by src/openclaw.ts from the
# records on the name, so the image holds nothing agent-specific and every
# capsule in the fleet runs the identical one.
#
# Pinned, never `latest`. A gateway that changed under a running fleet would be a
# fleet-wide behaviour change with no transaction behind it — precisely the thing
# this project claims cannot happen to a capsule.
FROM ghcr.io/openclaw/openclaw:2026.9.3

# NOT /app. The base image installs the gateway there — its own `package.json`,
# its `node_modules`, `openclaw.mjs`. Building the supervisor into the same
# directory overwrites the first and `npm ci` prunes the second, which uninstalls
# the brain the supervisor exists to run. The failure is silent at build time and
# total at runtime, so the supervisor gets its own directory and touches nothing
# the gateway owns.
USER root
RUN mkdir -p /capsule && chown node:node /capsule
USER node
WORKDIR /capsule

# Dependencies first: a source edit should not reinstall the world.
#
# `--include=dev` is load-bearing, not laziness. The base image sets
# NODE_ENV=production, under which `npm ci` omits devDependencies — and `tsx` is
# one, because the supervisor is TypeScript that is never compiled. Without this
# the image builds clean, passes every check that does not start it, and dies on
# boot with "Cannot find package 'tsx'". The runner never reaches its own first
# line, so nothing it would have told you about itself gets said.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --include=dev

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src

# Exec form, and one process.
#
# `npm start` would break the runner's shutdown outright: npm does not forward
# SIGTERM to its child, so a machine being stopped would never reach the
# graceful path and would look, in the logs, exactly like one being killed.
#
# The tsx CLI forks a child too — measured, and it does forward the signal
# correctly — but `node --import tsx` runs in a single process, so the signal
# lands on the code that handles it with nothing in between. That matters more
# now than it did: the handler is what stops the gateway, and a bot still
# answering after its supervisor is gone is a recall that did not land.
# The base image's ENTRYPOINT is `tini -s --` and is deliberately inherited: the
# supervisor spawns a child that spawns its own, and PID 1 needs to reap them.
CMD ["node", "--import", "tsx", "/capsule/src/runner.ts"]
