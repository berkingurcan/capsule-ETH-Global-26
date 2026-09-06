# The agent, in a box.
#
# Configuration arrives entirely through the environment at `docker run` — no
# config file, no baked secrets — which is the same shape the provisioner uses
# when it creates a Fly machine over the API in build step 4.
FROM node:24-alpine

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
# lands on the code that handles it with nothing in between.
CMD ["node", "--import", "tsx", "src/runner.ts"]
