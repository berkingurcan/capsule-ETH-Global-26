/**
 * The gateway, as a child process.
 *
 * The supervisor owns everything the ENS name controls — identity, config,
 * permission, lifetime. OpenClaw owns the model loop, the tools and the chat
 * surface. This module is the seam: it turns records into
 * `~/.openclaw/openclaw.json`, starts `openclaw gateway` in the foreground,
 * restarts it if it dies, and stops it before the supervisor exits.
 *
 * `openclaw gateway` is the foreground command — it is what OpenClaw's own
 * systemd unit puts in `ExecStart`, and `openclaw gateway install` is the
 * service installer wrapping it. A PID-1 supervisor wants the former.
 *
 * ## Where the secrets are, and are not
 *
 * API keys go in the child's **environment**, never into the config file.
 * OpenClaw reads built-in providers straight from `ANTHROPIC_API_KEY` and
 * friends, and interpolates `${VAR}` inside `models.providers.*.apiKey` for
 * custom ones, so the file never needs a literal.
 *
 * That is not fussiness. `Secret<T>` exists in this runner so a credential
 * cannot reach a log line by accident; writing the same value into a
 * world-readable JSON file in the container would route around that guard while
 * appearing to respect it. The config on disk is not a secret store and is not
 * treated as one.
 */
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CHAIN } from "./chain.js";
import type { CapsuleConfig } from "./config.js";
import { composePersona, type CapsuleStatus } from "./persona.js";
import { envVarFor, isBuiltInProvider } from "./providers.js";
import type { RuntimeCredentials } from "./runtime.js";

/** Where the gateway looks unless OPENCLAW_CONFIG_PATH says otherwise. */
export const CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

/** The agent's workspace, and so where its persona lives. */
export const WORKSPACE_PATH = join(homedir(), ".openclaw", "workspace");

/**
 * The file OpenClaw injects into the system prompt every turn.
 *
 * There is no `systemPrompt` config key. A persona reaches an OpenClaw agent as
 * a bootstrap file in its workspace, and `agents.defaults.contextInjection`
 * defaults to `"always"`. Measured against 2026.9.3: the gateway writes these
 * files only when they are absent, so one written before the child is spawned
 * survives startup untouched.
 *
 * `"always"` is also why the live status lives in this file rather than beside
 * it. A second file — `CAPSULE.md`, say — would be injected by nothing and read
 * only if the model remembered to go looking, which is exactly the failure this
 * whole change exists to fix. Re-injected every turn, this one is current by
 * construction, so the supervisor rewrites it in place each tick. See
 * `./persona.ts` for what goes in it and in what order.
 */
export const PERSONA_PATH = join(WORKSPACE_PATH, "AGENTS.md");

/**
 * How long the gateway gets to stop politely before it is killed.
 *
 * A clean shutdown was measured at 10.06s on 2026.9.3 — the channels get five
 * seconds to drain and Telegram takes all of it. At the old 10s this SIGKILLed
 * every single time, one tenth of a second from succeeding.
 */
const STOP_GRACE_MS = 15_000;

/** Restart backoff, so a gateway that cannot start does not spin. */
const RESTART_DELAY_MS = 3_000;

/** Ceiling on the backoff. Beyond this, waiting longer helps nobody. */
const MAX_RESTART_DELAY_MS = 60_000;

/**
 * Consecutive restarts before the supervisor stops treating this as a blip.
 *
 * It never stops the supervisor — the permission is still held and the
 * heartbeat is still true — but a gateway that has failed this many times in a
 * row is a capsule with no bot, and that has to be visible. The alternative is
 * the failure this constant exists for: a machine that ticks `authorized`
 * forever while nothing answers in Telegram.
 */
const RESTART_ALARM = 5;

export class OpenClawError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenClawError";
  }
}

////////////////////////////////////////////////////////////////////////////
// Configuration
////////////////////////////////////////////////////////////////////////////

/**
 * The config file, built from the name and nothing else.
 *
 * Everything here is public: a model reference anyone can resolve, and — for a
 * custom provider — a base URL and an API flavour. The `apiKey` field is an
 * interpolation token, not a key.
 */
/**
 * Who is allowed to DM this agent.
 *
 * OpenClaw's default DM policy is `pairing`: the owner messages the bot, and
 * somebody runs `openclaw pairing approve telegram <CODE>` to let them in. A
 * capsule is a headless machine with no shell, so under the default **the bot
 * never answers anyone, ever**.
 *
 * `CAPSULE_TELEGRAM_ALLOW_FROM` is a comma-separated list of numeric Telegram
 * user ids. Given one, the agent answers those people and nobody else. Given
 * nothing, it answers anyone who finds it — which matters more than it sounds,
 * because the bot handle is published on chain as `agent-endpoint[web]`, so
 * "anyone who finds it" is "anyone who reads the name". They spend the owner's
 * API key. Hence the warning, and hence this belongs in the sealed credential
 * payload beside the bot token rather than in an environment variable.
 */
function telegramAccess(): Record<string, unknown> {
  const raw = process.env.CAPSULE_TELEGRAM_ALLOW_FROM?.trim();
  if (raw === undefined || raw === "") {
    return { dmPolicy: "open", allowFrom: ["*"] };
  }

  const allowFrom = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  return allowFrom.length > 0 ? { dmPolicy: "allowlist", allowFrom } : { dmPolicy: "open", allowFrom: ["*"] };
}

/** Whether this capsule is answering the whole world. Reported at boot. */
export function telegramIsOpen(): boolean {
  return telegramAccess().dmPolicy === "open";
}

export function buildOpenClawConfig(
  config: CapsuleConfig,
  credentials: RuntimeCredentials,
): Record<string, unknown> {
  const { provider } = config.modelRef;

  const document: Record<string, unknown> = {
    agents: {
      defaults: {
        model: { primary: config.model },
        workspace: WORKSPACE_PATH,
        // Suppress OpenClaw's entire workspace bootstrap, `BOOTSTRAP.md` above
        // all. That file is a "birth sequence" the gateway seeds into any fresh
        // workspace, and its first instruction is: *introduce yourself as the
        // user's new assistant, then ask what they would like to call you.*
        //
        // Measured, not theorised. A capsule booted with it answered its owner
        // with "Hello Berkin. I'm your new assistant — what would you like to
        // call me?" while `AGENTS.md` on disk held the persona its name
        // published. The birth ritual competed with `agent-prompt` and won.
        //
        // For this project that is the worst possible reply. The whole claim is
        // that a name arrives already knowing what it is; an agent that opens by
        // asking to be named has contradicted it in one sentence, in front of
        // the person who paid a transaction to name it.
        //
        // `skipOptionalBootstrapFiles` cannot do this — it takes only SOUL.md,
        // USER.md and IDENTITY.md, and explicitly still writes AGENTS.md and
        // BOOTSTRAP.md. `skipBootstrap` suppresses all five. AGENTS.md is
        // unaffected because the supervisor writes it before the spawn: this
        // disables the gateway *creating* bootstrap files, not reading them.
        skipBootstrap: true,
      },
    },
  };

  // Telegram is the product surface, so its absence is worth stating rather
  // than shipping a capsule that heartbeats correctly and can never be spoken
  // to. The token is deliberately not here: `enabled` turns the plugin on and
  // it reads TELEGRAM_BOT_TOKEN from the environment, which is where a
  // credential belongs.
  if (credentials.telegramToken !== undefined) {
    document.channels = {
      telegram: {
        enabled: true,
        ...telegramAccess(),
      },
    };
  }

  // A built-in provider publishes its own catalog: naming it in the model
  // reference and putting its key in the environment is the whole setup, and an
  // explicit `models.providers` entry would override a catalog that is more
  // current than anything this repository could hardcode.
  if (!isBuiltInProvider(provider)) {
    const credential = credentials.providers.get(provider);
    if (credential === undefined || credential.baseUrl === undefined) {
      throw new OpenClawError(
        `${provider} is not a built-in provider and no baseUrl was stored for it`,
      );
    }

    document.models = {
      // Merge, not replace: the built-in catalog stays available so a later
      // model change to a built-in provider does not need this file rewritten
      // differently.
      mode: "merge",
      providers: {
        [provider]: {
          baseUrl: credential.baseUrl,
          apiKey: `\${${envVarFor(provider)}}`,
          api: credential.api ?? "openai-completions",
        },
      },
    };
  }

  return document;
}

/**
 * The child's environment.
 *
 * Only the credential for the provider this name currently references is passed
 * — the service already scoped the response that way, and this keeps the same
 * boundary on the process that would actually spend the key.
 */
export function buildOpenClawEnv(
  config: CapsuleConfig,
  credentials: RuntimeCredentials,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const credential of credentials.providers.values()) {
    env[envVarFor(credential.provider)] = credential.apiKey.value;
  }

  if (credentials.telegramToken !== undefined) {
    env.TELEGRAM_BOT_TOKEN = credentials.telegramToken.value;
  }

  env.OPENCLAW_CONFIG_PATH = CONFIG_PATH;

  // Who this agent is, for anything in the gateway that runs a command rather
  // than reads a file — a tool, a script, a shell. Every one of these values is
  // already public: three of them are literally text records anybody can
  // resolve, and the fourth is the address those records point at.
  //
  // `AGENT_KEY` is not here and must never be. Note the shape of the guard: the
  // allowlist above builds this object from nothing rather than filtering
  // `process.env`, so a new secret in the supervisor's environment is excluded
  // by default instead of needing to be remembered. Adding public facts does not
  // weaken that — it just means the child now knows its own name, which is the
  // difference between an agent that can answer "who are you" and one that
  // truthfully reports it has no idea.
  env.CAPSULE_NAME = config.name;
  env.CAPSULE_AGENT_ADDRESS = config.agent;
  env.CAPSULE_NODE = config.node;
  env.CAPSULE_RESOLVER = config.resolver;
  env.CAPSULE_CHAIN_ID = String(CHAIN.id);

  // Opt-in, and deliberately not `SEPOLIA_RPC_URL`.
  //
  // The supervisor's RPC URL usually carries a provider key in its path, which
  // makes it a credential wearing a URL's clothes — handing it to a process that
  // executes model-chosen tools would undo the paragraph above. So the operator
  // names a separate endpoint they are willing to have the agent spend, and
  // absent one the agent reads its balance out of its own status block instead
  // of from a node.
  const agentRpc = process.env.CAPSULE_AGENT_RPC_URL?.trim();
  if (agentRpc !== undefined && agentRpc !== "") env.CAPSULE_RPC_URL = agentRpc;

  // Without this the gateway refuses to start at all. Measured against 2026.9.3:
  // it detects a container, defaults to bind=auto, and exits with "Refusing to
  // bind gateway to auto without auth" — instantly, every time.
  //
  // That exit is the most dangerous one in this system, because the supervisor
  // does not depend on the gateway for anything: it would restart a child that
  // can never start, tick `authorized`, and pay for heartbeats, while the
  // dashboard and the chain both showed a healthy capsule that had never once
  // been able to answer a message. A silent bot is supposed to mean recalled.
  //
  // Fresh per boot and never logged. Telegram is the surface; nothing reaches
  // the Control UI, so this token authenticates no one and needs no stability.
  env.OPENCLAW_GATEWAY_TOKEN = randomBytes(32).toString("hex");

  // Set by the base image and dropped by the allowlist above, which exists to
  // keep AGENT_KEY away from the gateway rather than to withhold these.
  for (const passthrough of ["NODE_ENV", "PLAYWRIGHT_BROWSERS_PATH", "OPENCLAW_STATE_DIR"]) {
    const value = process.env[passthrough];
    if (value !== undefined) env[passthrough] = value;
  }

  return env;
}

/**
 * Write the workspace file the model reads every turn.
 *
 * Takes the composed document — identity, status and the `agent-prompt` body —
 * not the prompt alone. Before any of this existed the body was fetched,
 * measured, logged as a digest and dropped, so every capsule in the fleet booted
 * as the same default assistant no matter what its name said.
 *
 * Owner-only, like the config: none of it is a secret the way an API key is, but
 * nothing else in the image has any business reading it.
 *
 * Written through a temporary file and renamed, because the tick loop rewrites
 * this while the gateway is running and `rename(2)` within a directory is
 * atomic. A plain overwrite has a window in which the file on disk is half the
 * old document and half the new one, and the reader in that window is a language
 * model being told who it is.
 */
export async function writePersona(document: string, path = PERSONA_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = document.endsWith("\n") ? document : `${document}\n`;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Everything wrong with running this config, before anything is spawned.
 *
 * Called on every model change. Returning problems rather than throwing is the
 * point: the caller keeps the last good configuration running and warns, because
 * a capsule that dies when its owner mistypes a model name is indistinguishable
 * on a dashboard from one that was recalled.
 */
export function runtimeProblems(
  config: CapsuleConfig,
  credentials: RuntimeCredentials,
): string[] {
  const problems: string[] = [];
  const { provider } = config.modelRef;
  const credential = credentials.providers.get(provider);

  if (credential === undefined) {
    problems.push(
      `no stored key for ${provider} — add one in the launchpad, then this model will start`,
    );
  } else if (!isBuiltInProvider(provider) && credential.baseUrl === undefined) {
    problems.push(`${provider} is a custom provider and no baseUrl was stored for it`);
  }

  return problems;
}

export async function writeOpenClawConfig(
  document: Record<string, unknown>,
  path = CONFIG_PATH,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Owner-only. The file carries no secret, but it carries the exact shape of
  // this agent, and there is no reason for anything else in the image to read it.
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}

////////////////////////////////////////////////////////////////////////////
// The process
////////////////////////////////////////////////////////////////////////////

export type GatewayLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/**
 * A supervised `openclaw gateway`.
 *
 * Restarts on an unexpected exit, stays down on a requested one, and never
 * throws into the tick loop — a gateway that will not start is a problem to
 * report, not a reason for the supervisor to stop proving it is authorized.
 */
export class Gateway {
  #child: ChildProcess | undefined;
  #stopping = false;
  #restartTimer: NodeJS.Timeout | undefined;
  #env: Record<string, string> = {};
  #starts = 0;
  #failures = 0;
  readonly #log: GatewayLogger;

  // What the workspace file is built from. Held here because the two halves
  // arrive on completely different cadences — the config and the prompt body on
  // an apply, the status on every tick — and either one alone cannot rebuild
  // the document. Before this, the supervisor knew all of it and told the model
  // none of it.
  #config: CapsuleConfig | undefined;
  #body = "";
  #status: CapsuleStatus | undefined;

  /**
   * The document as last written, so an identical render is not rewritten.
   *
   * The `As of` stamp advances every tick, so in steady state this does not fire
   * — the file genuinely is different each time and a few kilobytes every
   * TICK_SECONDS is not worth optimising away. What it does catch is the double
   * render at boot, where `apply` composes the file immediately after
   * `updateStatus` stored the status that goes in it.
   */
  #written: string | undefined;

  constructor(log: GatewayLogger) {
    this.#log = log;
  }

  get running(): boolean {
    return this.#child !== undefined && this.#child.exitCode === null;
  }

  get starts(): number {
    return this.#starts;
  }

  /**
   * Consecutive restarts with no successful run in between.
   *
   * The supervisor reads this rather than assuming a spawned child is a working
   * one. A capsule whose gateway cannot start is still authorized and still
   * beating, and both of those are true and neither means the bot works.
   */
  get failing(): boolean {
    return this.#failures >= RESTART_ALARM;
  }

  /**
   * Materialise the config and (re)start the child.
   *
   * Idempotent in the sense that matters: calling it again is how a model change
   * is applied, and the previous child is stopped first.
   */
  async apply(
    config: CapsuleConfig,
    credentials: RuntimeCredentials,
    persona: string,
  ): Promise<void> {
    const document = buildOpenClawConfig(config, credentials);
    this.#env = buildOpenClawEnv(config, credentials);
    await writeOpenClawConfig(document);
    // Before the spawn, always. The gateway reads this file at startup and
    // creates its own if it is missing, and an agent that boots once with a
    // generated persona has already introduced itself as somebody else.
    this.#config = config;
    this.#body = persona;
    await this.#writeWorkspace();

    if (this.running) await this.stop();
    this.#stopping = false;
    this.#failures = 0;
    this.#spawn();
  }

  /**
   * Refresh the live half of the workspace file. Never restarts the child.
   *
   * Called every tick, including the ticks where nothing happened — an agent
   * asked "are you still authorized" ten minutes into a silence should not be
   * answering from what was true at boot.
   *
   * Swallows its own failures on purpose, and says so once. A workspace file
   * that could not be rewritten is a stale self-description; it is not a reason
   * to stop proving to the chain that this agent is still authorized, and the
   * tick loop has exactly one fatal condition.
   */
  async updateStatus(status: CapsuleStatus): Promise<void> {
    this.#status = status;
    if (this.#config === undefined) return;
    try {
      await this.#writeWorkspace();
    } catch (error) {
      this.#log.warn(
        `could not refresh the workspace identity file — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #writeWorkspace(): Promise<void> {
    if (this.#config === undefined) return;
    const document = composePersona({
      config: this.#config,
      body: this.#body,
      status: this.#status,
    });
    if (document === this.#written) return;
    await writePersona(document);
    this.#written = document;
  }

  #spawn(): void {
    if (this.#stopping) return;

    this.#starts += 1;
    // `--allow-unconfigured` is what lets the gateway start without having been
    // through `openclaw onboard`, which is a first-run wizard that writes a
    // token and an auth-profile directory. A capsule's config arrives complete
    // from its own ENS records; there is no first run to sit through.
    const child = spawn("openclaw", ["gateway", "--allow-unconfigured"], {
      // The credential lives here and only here. Inheriting the supervisor's
      // environment would hand the gateway AGENT_KEY, which is the one key in
      // this system that must never leave the supervisor: it is what proves the
      // agent's identity to the chain and to the control plane.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? homedir(),
        ...this.#env,
      },
      stdio: ["ignore", "inherit", "inherit"],
    });

    this.#child = child;

    // A child that has been up long enough to be doing its job resets the
    // backoff. Without this, a gateway restarted once an hour for a year would
    // eventually be waiting a minute to come back from an unrelated blip.
    const healthy = setTimeout(() => {
      this.#failures = 0;
    }, MAX_RESTART_DELAY_MS);
    healthy.unref();

    child.on("exit", (code, signal) => {
      clearTimeout(healthy);
      if (this.#stopping) return;

      this.#failures += 1;
      // Exponential, capped. A gateway that cannot start — a bad model, a
      // revoked API key, a token Telegram no longer honours — must not spin at
      // one attempt every three seconds for the life of the machine.
      const delay = Math.min(RESTART_DELAY_MS * 2 ** (this.#failures - 1), MAX_RESTART_DELAY_MS);

      this.#log.warn(
        `gateway exited (${signal ?? `code ${code}`}) — restart ${this.#failures} in ${delay / 1000}s`,
      );
      if (this.#failures === RESTART_ALARM) {
        // Said once, and plainly. The permission is intact and the heartbeat is
        // honest; what is broken is the only part the owner can see.
        this.#log.warn(
          `gateway has failed ${RESTART_ALARM} times in a row — this capsule is authorized, beating, and cannot answer a message`,
        );
      }
      this.#restartTimer = setTimeout(() => this.#spawn(), delay);
      this.#restartTimer.unref();
    });

    child.on("error", (error) => {
      // spawn failed outright — usually the binary is not on PATH. Loud, and
      // still not fatal to the supervisor.
      this.#log.warn(`gateway could not start — ${error.message}`);
    });
  }

  /**
   * Stop the child and stay stopped.
   *
   * Called on revocation before the supervisor exits, because a recall has to
   * reach the thing the owner can actually see, and what they can see is a
   * Telegram chat that either answers or does not.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer !== undefined) clearTimeout(this.#restartTimer);

    const child = this.#child;
    if (child === undefined || child.exitCode !== null) return;

    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, STOP_GRACE_MS);
      kill.unref();

      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });

      child.kill("SIGTERM");
    });

    this.#child = undefined;
  }
}
