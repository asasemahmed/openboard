/**
 * Local security checks, shared by HTTP requests and WebSocket upgrades (see
 * "Local security" in docs/ARCHITECTURE.md).
 *
 * - `Host` must be a loopback name. A page on attacker.example that rebinds
 *   its DNS name to 127.0.0.1 still sends `Host: attacker.example`, so this
 *   check is what closes DNS rebinding.
 * - A request that carries `Origin` (every cross-site browser request does)
 *   must come from the server's own origin, so another site open in the
 *   browser cannot drive the API or join a board's socket.
 */

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];

/** The web app's dev server. It talks to the API and the socket from its own origin. */
export const DEV_PORTS: readonly number[] = [5173];
export const ALLOW_DEV_ORIGINS: ReadonlySet<string> = new Set(
  DEV_PORTS.flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]),
);

const LOOPBACK_BIND = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackBind(host: string): boolean {
  return LOOPBACK_BIND.has(host) || host.startsWith('127.');
}

export interface SecurityConfig {
  /** The port the server listens on. */
  port: number;
  /** False when the server was bound to a non-loopback interface on purpose. */
  checkHost: boolean;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Loopback `Host` values this server answers to: its own port, and the dev server's (proxied requests). */
function allowedHosts(port: number): Set<string> {
  const hosts = new Set<string>();
  for (const p of [port, ...DEV_PORTS])
    for (const name of LOOPBACK_NAMES) hosts.add(`${name}:${p}`);
  return hosts;
}

/**
 * Check one request.
 *
 * @param devAllowed whether the request targets the API or the socket, where
 *   the dev server's origin is accepted too.
 */
export function checkRequest(
  config: SecurityConfig,
  headers: { host: string | undefined; origin: string | undefined },
  devAllowed: boolean,
): Verdict {
  const host = headers.host?.toLowerCase();
  if (config.checkHost) {
    if (!host || !allowedHosts(config.port).has(host)) {
      return { ok: false, reason: `host ${JSON.stringify(headers.host ?? '')} is not allowed` };
    }
  }
  const origin = headers.origin;
  if (origin === undefined) return { ok: true };
  const normalized = origin.toLowerCase();
  if (host && normalized === `http://${host}`) return { ok: true };
  if (config.checkHost && isOwnOrigin(normalized, config.port)) return { ok: true };
  if (devAllowed && ALLOW_DEV_ORIGINS.has(normalized)) return { ok: true };
  return { ok: false, reason: `origin ${JSON.stringify(origin)} is not allowed` };
}

function isOwnOrigin(origin: string, port: number): boolean {
  return LOOPBACK_NAMES.some((name) => origin === `http://${name}:${port}`);
}
