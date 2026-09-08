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
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CapsuleConfig } from "./config.js";
import { envVarFor, isBuiltInProvider } from "./providers.js";
import type { RuntimeCredentials } from "./runtime.js";

/** Where the gateway looks unless OPENCLAW_CONFIG_PATH says otherwise. */
export const CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

/** How long the gateway gets to stop politely before it is killed. */
const STOP_GRACE_MS = 10_000;

/** Restart backoff, so a gateway that cannot start does not spin. */
const RESTART_DELAY_MS = 3_000;

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
export function buildOpenClawConfig(
  config: CapsuleConfig,
  credentials: RuntimeCredentials,
): Record<string, unknown> {
  const { provider } = config.modelRef;

  const document: Record<string, unknown> = {
    agents: {
      defaults: {
        model: { primary: config.model },
      },
    },
  };

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

  return env;
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
  readonly #log: GatewayLogger;

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
   * Materialise the config and (re)start the child.
   *
   * Idempotent in the sense that matters: calling it again is how a model change
   * is applied, and the previous child is stopped first.
   */
  async apply(
    config: CapsuleConfig,
    credentials: RuntimeCredentials,
  ): Promise<void> {
    const document = buildOpenClawConfig(config, credentials);
    this.#env = buildOpenClawEnv(config, credentials);
    await writeOpenClawConfig(document);

    if (this.running) await this.stop();
    this.#stopping = false;
    this.#spawn();
  }

  #spawn(): void {
    if (this.#stopping) return;

    this.#starts += 1;
    const child = spawn("openclaw", ["gateway"], {
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

    child.on("exit", (code, signal) => {
      if (this.#stopping) return;

      this.#log.warn(
        `gateway exited (${signal ?? `code ${code}`}) — restarting in ${RESTART_DELAY_MS / 1000}s`,
      );
      this.#restartTimer = setTimeout(() => this.#spawn(), RESTART_DELAY_MS);
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
