/**
 * The seam, without the chain.
 *
 * Boots a real `openclaw gateway` from a config this supervisor generated, with
 * a fake capsule standing in for the records. It needs no RPC, no key, no
 * credential and no network — which is the point: everything it checks is
 * between the supervisor and the gateway, and none of it should depend on
 * Sepolia being reachable to find out about.
 *
 * It exists because four bugs shipped past a green typecheck and a clean build,
 * and every one of them was invisible until something actually started:
 *
 *   - the supervisor's build wiped the gateway out of the image
 *   - `tsx` was a devDependency the production image would not install
 *   - the gateway refused to boot without OPENCLAW_GATEWAY_TOKEN
 *   - the persona was fetched, logged and dropped
 *
 * Run it inside the built image, where all four are testable. `dev/` is
 * .dockerignored on purpose — the agent's image carries nothing it does not need
 * to be an agent — so the test is mounted in for the run and leaves nothing
 * behind:
 *
 *   docker build -t capsule-runner .
 *   docker run --rm --network none -v "$PWD/dev:/capsule/dev:ro" \
 *     --entrypoint node capsule-runner --import tsx /capsule/dev/gateway-smoke.ts
 *
 * Read-only, one directory, and the repo's own. Nothing else on the host is
 * visible to the container, which matters more than usual here: the child this
 * spawns is an agent runtime that executes tools.
 *
 * `--network none` is deliberate. Telegram and the model API are unreachable and
 * say so loudly, and the gateway still has to reach `ready` — a capsule that
 * only starts when the internet is perfect is one that stops on a bad minute.
 */
import { readFile } from "node:fs/promises";
import { Gateway, PERSONA_PATH, buildOpenClawConfig } from "../src/openclaw.js";
import { Secret } from "../src/secret.js";
import type { CapsuleConfig } from "../src/config.js";
import type { RuntimeCredentials } from "../src/runtime.js";

const SENTINEL = "CAPSULE-PERSONA-SENTINEL";

/** How long the gateway gets to reach `ready` before we call it failed. */
const SETTLE_MS = 20_000;

const config = {
  name: "smoke.capsulefleet.eth",
  node: "0x00",
  resolver: "0x0000000000000000000000000000000000000001",
  agent: "0x0000000000000000000000000000000000000002",
  model: "anthropic/claude-opus-4-6",
  modelRef: { provider: "anthropic", model: "claude-opus-4-6" },
  endpoint: "http://localhost:8787",
  promptRef: "cap_smoke",
  heartbeat: { raw: "beat-1", sequence: 1 },
} as unknown as CapsuleConfig;

const credentials = {
  model: "anthropic/claude-opus-4-6",
  providers: new Map([
    [
      "anthropic",
      {
        provider: "anthropic",
        // Never spent: nothing in this test reaches a model.
        apiKey: new Secret("sk-ant-smoke-not-a-real-key"),
        baseUrl: undefined,
        api: undefined,
      },
    ],
  ]),
  telegramToken: new Secret("000000:smoke-not-a-real-token"),
} as unknown as RuntimeCredentials;

async function main() {
  const failures: string[] = [];

  const document = buildOpenClawConfig(config, credentials);
  console.log(JSON.stringify(document, null, 2));

  const serialised = JSON.stringify(document);
  // The config file is not a secret store, and the way that stops being true is
  // gradual and unnoticed. Assert it here rather than trusting a code review.
  if (serialised.includes("smoke-not-a-real-token") || serialised.includes("sk-ant")) {
    failures.push("a credential reached the config document");
  }
  if (!serialised.includes("telegram")) {
    failures.push("telegram was not configured — the capsule would have no surface");
  }

  const gateway = new Gateway({
    info: (message) => console.log(`   ${message}`),
    warn: (message) => console.warn(`⚠️  ${message}`),
  });

  await gateway.apply(config, credentials, `${SENTINEL}\nYou are smoke.capsulefleet.eth.`);

  const onDisk = await readFile(PERSONA_PATH, "utf8");
  if (!onDisk.includes(SENTINEL)) {
    failures.push("the persona the supervisor wrote is not the one on disk");
  }

  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

  // The whole bug class this file exists for: a child that was spawned is not a
  // child that is running, and the supervisor used to assume otherwise.
  if (!gateway.running) failures.push("the gateway did not stay up");
  if (gateway.failing) failures.push("the gateway restart-looped");
  if (gateway.starts !== 1) failures.push(`the gateway started ${gateway.starts} times, expected 1`);

  await gateway.stop();

  if (failures.length > 0) {
    for (const failure of failures) console.error(`❌ ${failure}`);
    process.exit(1);
  }
  console.log(`✅ gateway up, persona in place, no credential on disk · ${gateway.starts} start`);
}

main().catch((error) => {
  console.error(`❌ smoke test crashed — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
