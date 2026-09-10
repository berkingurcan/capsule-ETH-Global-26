/**
 * Thin client for the Fly Machines API.
 *
 * Only the calls the provisioner needs, typed to what we actually read back.
 * Kept as a library rather than a service so the whole backend stays one
 * Vercel deployment: the Machines API is plain HTTP, so a route handler can
 * drive it directly and there is nothing for a second process to do.
 */

const FLY_API = "https://api.machines.dev/v1";

export class FlyError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, action: string) {
    super(`fly ${action} failed with ${status}: ${body.slice(0, 300)}`);
    this.name = "FlyError";
    this.status = status;
    this.body = body;
  }
}

export type FlyConfig = {
  token: string;
  appName: string;
};

async function flyFetch(
  cfg: FlyConfig,
  path: string,
  init: RequestInit & { action: string },
): Promise<unknown> {
  const { action, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(`${FLY_API}${path}`, {
      ...rest,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        "content-type": "application/json",
        ...(rest.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new FlyError(0, error instanceof Error ? error.message : String(error), action);
  }

  const text = await response.text();
  if (!response.ok) throw new FlyError(response.status, text, action);
  return text === "" ? null : JSON.parse(text);
}

export type FlyApp = { name: string; status: string; organization?: { slug?: string } };

/** Does the app exist and can this token see it? The preflight's Fly check. */
export async function getApp(cfg: FlyConfig): Promise<FlyApp> {
  return (await flyFetch(cfg, `/apps/${encodeURIComponent(cfg.appName)}`, {
    method: "GET",
    action: "get app",
  })) as FlyApp;
}

////////////////////////////////////////////////////////////////////////////
// Machines
////////////////////////////////////////////////////////////////////////////

/**
 * The metadata key that says which capsule a machine belongs to.
 *
 * Identity is metadata, not the machine name. Fly does not enforce unique
 * machine names within an app, so keying on the name would let a second
 * provision of the same capsule create a second runner — two containers
 * heartbeating from one agent key, racing each other's nonce, each one
 * looking like the whole capsule in the logs.
 */
export const MACHINE_CAPSULE_NAME = "capsule_name";

/** What we read back. Fly returns far more; this is the part we act on. */
export type FlyMachine = {
  id: string;
  name: string;
  state: string;
  region: string;
  created_at?: string;
  config?: { metadata?: Record<string, string> };
};

/**
 * States a machine can be in and still be gone.
 *
 * `include_deleted` defaults to false, but a machine mid-teardown is still
 * listed and is not a runner. Treating one as live would make provisioning a
 * no-op for a capsule that has nothing running.
 */
const DEAD_STATES = new Set(["destroyed", "destroying"]);

export async function listMachines(cfg: FlyConfig): Promise<FlyMachine[]> {
  const machines = (await flyFetch(cfg, `/apps/${encodeURIComponent(cfg.appName)}/machines`, {
    method: "GET",
    action: "list machines",
  })) as FlyMachine[] | null;
  return machines ?? [];
}

/** The live machine for one capsule, or null. The idempotency check. */
export async function findCapsuleMachine(
  cfg: FlyConfig,
  capsuleName: string,
): Promise<FlyMachine | null> {
  const wanted = capsuleName.toLowerCase();
  const machines = await listMachines(cfg);
  return (
    machines.find(
      (machine) =>
        !DEAD_STATES.has(machine.state) &&
        machine.config?.metadata?.[MACHINE_CAPSULE_NAME]?.toLowerCase() === wanted,
    ) ?? null
  );
}

export type CreateMachineArgs = {
  /** Display only — see MACHINE_CAPSULE_NAME. */
  name: string;
  region: string;
  image: string;
  /** The runner's entire configuration. There is no config file in the image. */
  env: Record<string, string>;
  memoryMb: number;
  metadata: Record<string, string>;
};

/**
 * Creates and starts one runner.
 *
 * Two parts of this config are load bearing rather than conventional.
 *
 * **`restart.policy = "on-failure"`.** The kill switch is `exit 0`: when the
 * owner revokes `agent-heartbeat`, the supervisor stops the gateway and exits
 * cleanly. Under Fly's default `always` policy that clean exit is restarted, and
 * the recall the owner just paid for becomes a container that comes back a few
 * seconds later. `on-failure` is what makes exit 0 mean "retire me".
 *
 * **The memory floor.** The gateway, the supervisor and Codex measured 842 MiB
 * together (GATE-LOG.md). A 512 MB machine OOMs before the bot answers, and the
 * failure is disguised: Fly restarts, the supervisor boots clean, the heartbeat
 * resumes, and nothing in the log says "memory". The caller supplies the number
 * and `loadProvisionerEnv` refuses one below 1024.
 *
 * No `services` block: the runner listens on nothing. It makes outbound calls to
 * an RPC, to the control plane and to Telegram, and accepts no inbound traffic,
 * so it needs no ports, no IP and no health checks.
 */
export async function createMachine(cfg: FlyConfig, args: CreateMachineArgs): Promise<FlyMachine> {
  return (await flyFetch(cfg, `/apps/${encodeURIComponent(cfg.appName)}/machines`, {
    method: "POST",
    action: "create machine",
    body: JSON.stringify({
      name: args.name,
      region: args.region,
      config: {
        image: args.image,
        env: args.env,
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: args.memoryMb },
        restart: { policy: "on-failure", max_retries: 10 },
        auto_destroy: false,
        metadata: args.metadata,
      },
    }),
  })) as FlyMachine;
}

/**
 * Destroys a machine, running or not.
 *
 * Not reachable from any route. It exists for `check:provision`, which creates a
 * real machine to prove the config shape is one Fly accepts and must not leave
 * it behind, and for an operator cleaning up by hand. Recall does not go through
 * here: revoking `agent-heartbeat` stops the agent from the chain, which is the
 * whole claim, and a kill switch that needed our Fly token would be a kill
 * switch that stops working the day this deployment does.
 */
export async function destroyMachine(cfg: FlyConfig, machineId: string): Promise<void> {
  await flyFetch(
    cfg,
    `/apps/${encodeURIComponent(cfg.appName)}/machines/${encodeURIComponent(machineId)}?force=true`,
    { method: "DELETE", action: "destroy machine" },
  );
}
