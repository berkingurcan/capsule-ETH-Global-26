/**
 * Writes one heartbeat, and reacts to it not being allowed.
 *
 *   npm run heartbeat
 *
 * Exit codes are load-bearing. A revoked agent exits 0: it did not crash, it
 * did the thing it was built to do. Fly restarts on failure, so exiting 1 here
 * would turn the kill switch into a crash loop — boot, read, beat, revert, die,
 * repeat. Everything else keeps exiting 1, because bad config, no gas and an
 * unreachable chain might all be fixed by the time it comes back up.
 */
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { createRunnerClient, createRunnerWallet } from "./chain.js";
import { ConfigError, loadCapsuleConfig } from "./config.js";
import { InvalidEnvError, MissingEnvError, loadEnv } from "./env.js";
import { shortRevert } from "./errors.js";
import { classifyHeartbeatFailure, confirmRevoked } from "./halt.js";
import { heartbeatValue, writeHeartbeat } from "./heartbeat.js";

async function main() {
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof MissingEnvError || error instanceof InvalidEnvError) {
      console.error(`❌ env       ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const account = privateKeyToAccount(env.agentKey);
  const publicClient = createRunnerClient(env.rpcUrl);
  const walletClient = createRunnerWallet(env.rpcUrl, account);

  let config;
  try {
    config = await loadCapsuleConfig(publicClient, env.capsuleName, account.address);
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) console.error(`❌ ${problem}`);
      console.error("config failed");
      process.exit(1);
    }
    throw error;
  }

  const sequence = config.heartbeat.sequence + 1;
  const previous = config.heartbeat.raw === "" ? "(never beaten)" : config.heartbeat.raw;

  console.log(`   capsule    ${config.name}`);
  console.log(`   resolver   ${config.resolver} (discovered)`);
  console.log(`   writing    setText(agent.heartbeat, "${heartbeatValue(sequence)}") as ${account.address}`);

  try {
    const result = await writeHeartbeat({ publicClient, walletClient, config, sequence });
    console.log(`✅ sent       ${result.hash}`);
    console.log(
      `✅ mined      block ${result.blockNumber} · ${result.gasUsed.toLocaleString("en-US")} gas`,
    );
    console.log(`✅ heartbeat  ${previous} → ${result.value}`);
    return;
  } catch (error) {
    if (classifyHeartbeatFailure(error) === "transient") {
      console.error(`⚠️  transient  ${shortRevert(error)}`);
      console.error("heartbeat failed — not a revocation");
      process.exit(1);
    }

    // Denied. Now find out what was actually taken away, because the revert
    // reports the name-level resource whichever key you were refused on.
    console.log(`🔴 denied     setText(agent.heartbeat) refused by the resolver`);

    const { revoked, roles } = await confirmRevoked(publicClient, config, account.address);

    if (!revoked) {
      // The role is still held, so this was something else wearing a
      // revocation's clothes. Keep running rather than dying of a guess.
      console.error(
        `⚠️  inconsistent  denied, but ROLE_SET_TEXT is still held (name ${roles.perName}, wildcard ${roles.wildcard})`,
      );
      console.error("heartbeat failed — not a revocation");
      process.exit(1);
    }

    console.log(`🔴 confirmed  no ROLE_SET_TEXT on agent.heartbeat, and none via the wildcard`);
    console.log(`🔴 halted     ${config.name} · last beat ${previous}`);
    // There is nothing to write on the way out. The one record this agent was
    // allowed to touch is the one it has just been locked out of, so its death
    // has no on-chain notice — only the owner's revocation event, which the
    // subgraph in build step 5 indexes.
    console.log("runner halted");
    process.exit(0);
  }
}

main().catch((error) => {
  console.error(`❌ heartbeat crashed — ${shortRevert(error)}`);
  process.exit(1);
});
