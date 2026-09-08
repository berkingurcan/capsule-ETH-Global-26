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

WORKDIR /app
RUN chown node:node /app
USER node

# Dependencies first: a source edit should not reinstall the world.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

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
CMD ["node", "--import", "tsx", "src/runner.ts"]
