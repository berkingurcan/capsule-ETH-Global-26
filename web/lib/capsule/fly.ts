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
