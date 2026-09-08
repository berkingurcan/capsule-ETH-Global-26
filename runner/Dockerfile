# The agent, in a box.
#
# Two things live in this image: the OpenClaw gateway, which is the agent, and the Capsule
# supervisor, which decides whether that agent may exist. The supervisor is PID 1 and
# starts the gateway as its child — see src/openclaw.ts for why that direction and not the
# other one. Nothing in here is the agent's identity: that arrives as CAPSULE_NAME, and
# everything else is read off the chain at boot.
#
# Configuration arrives entirely through the environment at `docker run` — no config file,
# no baked secrets — which is the same shape the provisioner uses when it creates a Fly
# machine over the API.

# ---- build ------------------------------------------------------------------
#
# The supervisor is compiled to plain JavaScript here rather than run through tsx in the
# final image. Two reasons, and the second is the load-bearing one:
#
#   * tsx pulls in esbuild, which is a native binary — one built against musl on Alpine
#     does not run on the OpenClaw image's glibc, and the failure is at startup.
#   * `node dist/runner.js` is a single process, so SIGTERM lands directly on the handler
#     that stops the gateway. `npm start` would not: npm does not forward signals, and a
#     machine being stopped would never reach the graceful path — it would look, in the
#     logs, exactly like one being killed.
#
# What ships is therefore plain JS plus viem and dotenv, both pure JavaScript.
FROM node:24-bookworm-slim AS build

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# A second, production-only install: the image must not carry typescript or esbuild.
RUN npm ci --omit=dev

# ---- runtime ----------------------------------------------------------------
#
# Pinned rather than :latest. The gateway is the part a user talks to, and an image that
# silently changes under a running fleet is the kind of thing that gets discovered during
# a demo. Bump it deliberately.
FROM ghcr.io/openclaw/openclaw:2026.2.26

USER root
RUN mkdir -p /app /home/node/.openclaw/workspace \
    && chown -R node:node /app /home/node/.openclaw
USER node

WORKDIR /app
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/dist ./dist
COPY --chown=node:node package.json ./

# Where the supervisor writes openclaw.json and the workspace bootstrap files, and how it
# starts the gateway. Both are overridable so the image can be exercised without one.
ENV OPENCLAW_HOME=/home/node/.openclaw \
    OPENCLAW_BIN=openclaw \
    NODE_ENV=production

# The gateway's own health endpoint. Unauthenticated by design, loopback only here.
EXPOSE 18789
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:18789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form. The supervisor must be PID 1 so it receives SIGTERM from `docker stop` and
# `fly machine stop`, stops the gateway, and exits 0 — a graceful stop and a revocation
# both end this container, and only the logs distinguish them.
ENTRYPOINT ["node", "dist/runner.js"]
