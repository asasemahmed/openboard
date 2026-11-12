/**
 * Who is calling, in both modes (see "Shared mode" in docs/ARCHITECTURE.md).
 *
 * Local mode: everyone who passes the Host/Origin checks is the owner, and the
 * actor is whatever the `x-openboard-actor-*` headers say, as before.
 *
 * Shared mode: a caller presents a bearer token, a sync ticket or the session
 * cookie, and its actor id and kind come from the grant, never from headers
 * (only the display name may). Without credentials, only a request that
 * `isLocalOwnerRequest` accepts is trusted, as the owner at this machine.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { type AccessVia, type Actor, OpenBoardError, type Role } from '@openboard/core';
import { type AccessStore, cleanName } from './access.js';
import { ANONYMOUS_AGENT, actorFromHeaders } from './actor.js';
import type { CallerInfo } from './types.js';

/** The caller of one request or socket, as the server established it. */
export interface Caller extends CallerInfo {
  /** For `session` callers: the hash of the session id, to end its sockets on logout. */
  sessionHash?: string;
}

export const SESSION_COOKIE = 'openboard_session';
/** With `Secure`, the `__Host-` prefix also pins the cookie to this host and path `/`. */
export const SECURE_SESSION_COOKIE = '__Host-openboard_session';

/** Headers a proxy or tunnel adds. Any one of them means the request was relayed. */
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'fly-client-ip',
  'fastly-client-ip',
  'x-cluster-client-ip',
  'cdn-loop',
  'via',
] as const;

/**
 * Header name prefixes that relays use for what they add: `X-Forwarded-Server`,
 * `X-Original-Forwarded-For`, Cloudflare's `CF-*`, Fly's `Fly-*`, Envoy's,
 * Tailscale's. Any such header means the request was relayed too.
 */
const FORWARDING_PREFIXES = [
  'x-forwarded-',
  'x-original-',
  'cf-',
  'fly-',
  'x-envoy-',
  'tailscale-',
] as const;

/** Whether a header name is one a relay adds. */
export function isForwardingHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    (FORWARDING_HEADERS as readonly string[]).includes(lower) ||
    FORWARDING_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const plain = address.startsWith('::ffff:') ? address.slice(7) : address;
  return plain === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain);
}

export interface LocalRequest {
  /** The TCP peer of the socket, not anything a header says. */
  remoteAddress: string | undefined;
  /** The `Host` header. */
  host: string | undefined;
  /** The port this server listens on. */
  port: number;
  header: (name: string) => string | undefined;
  /** The names of every header of the request, for the forwarding check. */
  headerNames?: () => Iterable<string>;
}

/**
 * The one rule for trusting a request in shared mode without credentials: it
 * is the owner at this machine (the local CLI, the local MCP server, a browser
 * on this machine) when ALL of these hold:
 *
 * 1. the socket's peer address is loopback;
 * 2. the `Host` header is a loopback name on this server's port;
 * 3. it carries no forwarding header (`Forwarded`, `X-Forwarded-*`, ...;
 *    see `isForwardingHeader`).
 *
 * Why all three: a tunnel or reverse proxy on this machine (cloudflared, ngrok,
 * a local nginx) connects from loopback, so (1) alone would hand everyone on
 * the internet the owner's keys. Such a relay normally keeps the public
 * `Host` (caught by 2) or announces itself with `X-Forwarded-For` and friends
 * (caught by 3). A relay configured to rewrite `Host` to localhost AND to
 * strip every forwarding header is indistinguishable from a local program;
 * do not configure one that way in front of a shared server.
 */
export function isLocalOwnerRequest(request: LocalRequest): boolean {
  if (!isLoopbackAddress(request.remoteAddress)) return false;
  const host = request.host?.toLowerCase();
  if (!host || !LOOPBACK_HOSTS.some((name) => host === `${name}:${request.port}`)) return false;
  if (!FORWARDING_HEADERS.every((name) => request.header(name) === undefined)) return false;
  for (const name of request.headerNames?.() ?? []) if (isForwardingHeader(name)) return false;
  return true;
}

/**
 * The key failed attempts are counted under: the peer address, or, when the
 * peer is a relay on this machine, the client address it appended last to
 * `X-Forwarded-For` (earlier entries are whatever the client claimed).
 */
export function clientKey(
  remoteAddress: string | undefined,
  header: LocalRequest['header'],
): string {
  const peer = remoteAddress ?? 'unknown';
  if (!isLoopbackAddress(peer)) return peer;
  const forwarded = header('x-forwarded-for');
  const last = forwarded?.split(',').pop()?.trim();
  return last ? `${peer}>${last.slice(0, 64)}` : peer;
}

// ── Throttling ───────────────────────────────────────────────────────────────

export const THROTTLE_WINDOW_MS = 10 * 60_000;
export const THROTTLE_LIMIT = 20;
const THROTTLE_KEYS_MAX = 10_000;

/** Failed authentication attempts per client key, in a sliding window. Memory only. */
export class AuthThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly clock: () => number = () => Date.now(),
    readonly limit = THROTTLE_LIMIT,
    readonly windowMs = THROTTLE_WINDOW_MS,
  ) {}

  private recent(key: string): number[] {
    const now = this.clock();
    const list = (this.failures.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (list.length === 0) this.failures.delete(key);
    else this.failures.set(key, list);
    return list;
  }

  /** Seconds to wait before trying again, or 0 when the key may try now. */
  retryAfter(key: string): number {
    const list = this.recent(key);
    if (list.length < this.limit) return 0;
    const oldest = list[list.length - this.limit] as number;
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.clock()) / 1000));
  }

  fail(key: string): void {
    const list = this.recent(key);
    list.push(this.clock());
    // Never grow without bound: an attacker rotating addresses evicts old keys, not memory.
    if (!this.failures.has(key) && this.failures.size >= THROTTLE_KEYS_MAX) {
      const first = this.failures.keys().next().value;
      if (first !== undefined) this.failures.delete(first);
    }
    this.failures.set(key, list.slice(-this.limit));
  }
}

// ── Cookies ──────────────────────────────────────────────────────────────────

/** The value of one cookie from a `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function sessionCookie(
  name: string,
  value: string,
  options: { secure: boolean; maxAgeSeconds: number },
): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

// ── Secrets out of text ──────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/ob_[a-z0-9]{16}_[A-Za-z0-9_-]+/g, 'ob_<redacted>'],
  [/([?&](?:ticket|token)=)[^&\s"']+/gi, '$1<redacted>'],
  [/((?:__Host-)?openboard_session=)[^;\s"']+/g, '$1<redacted>'],
  [/(bearer\s+)[^\s"']+/gi, '$1<redacted>'],
];

/** Text with tokens, tickets and session cookies blanked out, for logs and error messages. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

// ── Authentication ───────────────────────────────────────────────────────────

export interface AuthConfig {
  store: AccessStore;
  shared: boolean;
  /** Whether cookies get `Secure` (the public URL is https). */
  secureCookies: boolean;
  /** The port the server listens on, known once it does. */
  port: () => number;
  clock?: () => number;
}

export interface AuthRequest extends Omit<LocalRequest, 'port'> {
  method: string;
}

export type AuthOutcome =
  | { ok: true; caller: Caller }
  | { ok: false; error: OpenBoardError; clearCookie?: boolean };

/** Credentials checks for HTTP requests and socket upgrades. */
export class Auth {
  readonly cookieName: string;
  readonly throttle: AuthThrottle;

  constructor(readonly config: AuthConfig) {
    this.cookieName = config.secureCookies ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
    this.throttle = new AuthThrottle(config.clock);
  }

  get shared(): boolean {
    return this.config.shared;
  }

  /** Milliseconds since the epoch, from the injected clock. */
  now(): number {
    return (this.config.clock ?? Date.now)();
  }

  get store(): AccessStore {
    return this.config.store;
  }

  /** The caller of a local-mode request: the header actor, as the owner. Throws `invalid_request`. */
  localCaller(actor: Actor, anonymous: boolean): Caller {
    return { actor, role: 'owner', via: 'local', shared: this.shared, anonymous };
  }

  /** Whether this request is the owner at this machine (see `isLocalOwnerRequest`). */
  isLocal(request: Omit<LocalRequest, 'port'>): boolean {
    return isLocalOwnerRequest({ ...request, port: this.config.port() });
  }

  grantCaller(
    grant: { id: string; actorId: string; kind: 'human' | 'agent'; role: Role; label: string },
    via: AccessVia,
    name: string | undefined,
    sessionHash?: string,
  ): Caller {
    const caller: Caller = {
      actor: { id: grant.actorId, kind: grant.kind, name: name ?? grant.label },
      role: grant.role,
      via,
      shared: true,
      anonymous: false,
      grantId: grant.id,
    };
    if (sessionHash !== undefined) caller.sessionHash = sessionHash;
    return caller;
  }

  /** Throws `rate_limited` while `key` has failed too often. */
  checkThrottle(key: string): void {
    const wait = this.throttle.retryAfter(key);
    if (wait > 0) {
      throw new OpenBoardError(
        'rate_limited',
        `too many failed sign-in attempts from this address; try again in ${wait} s`,
        { retryAfterSeconds: wait },
      );
    }
  }

  private failed(key: string, message: string, clearCookie = false): AuthOutcome {
    this.throttle.fail(key);
    return {
      ok: false,
      error: new OpenBoardError('unauthorized', message),
      ...(clearCookie ? { clearCookie } : {}),
    };
  }

  /**
   * Establish the caller. Credentials, when present, are used and must be
   * valid (a bad token is never "rescued" by local trust); without any, the
   * local-trust rule decides in shared mode. `ticket` is the `?ticket=` of a
   * socket upgrade; HTTP requests have none. `localActor` names the actor of a
   * trusted local caller (over HTTP: the `x-openboard-actor-*` headers); it may
   * throw `invalid_request`.
   */
  authenticate(
    request: AuthRequest,
    options: {
      ticket?: string | null;
      localActor?: () => { actor: Actor; anonymous: boolean };
    } = {},
  ): AuthOutcome {
    const ticket = options.ticket;
    const headerActor = () => {
      if (options.localActor) {
        const local = options.localActor();
        return this.localCaller(local.actor, local.anonymous);
      }
      const actor = actorFromHeaders(request.header);
      return this.localCaller(actor, actor === ANONYMOUS_AGENT);
    };
    if (!this.shared) {
      try {
        return { ok: true, caller: headerActor() };
      } catch (error) {
        return { ok: false, error: error as OpenBoardError };
      }
    }

    const key = clientKey(request.remoteAddress, request.header);
    const authorization = request.header('authorization');
    const cookie = readCookie(request.header('cookie'), this.cookieName);
    const presented =
      authorization !== undefined || (ticket ?? undefined) !== undefined || cookie !== undefined;
    if (presented) {
      try {
        this.checkThrottle(key);
      } catch (error) {
        return { ok: false, error: error as OpenBoardError };
      }
    }
    const name = cleanName(decodeName(request.header('x-openboard-actor-name')));

    if (authorization !== undefined) {
      const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
      if (!match) return this.failed(key, 'the Authorization header must be "Bearer <token>"');
      const grant = this.store.verifyToken(match[1] as string);
      if (!grant)
        return this.failed(key, 'the access token is not valid: it is wrong, expired or revoked');
      return { ok: true, caller: this.grantCaller(grant, 'token', name) };
    }

    if (ticket !== undefined && ticket !== null) {
      const used = this.store.consumeTicket(ticket);
      if (!used)
        return this.failed(key, 'the sync ticket is not valid: it is unknown, used or expired');
      return {
        ok: true,
        caller: this.grantCaller(
          used.grant,
          used.ticket.via,
          used.ticket.name ?? name,
          used.ticket.sessionHash,
        ),
      };
    }

    if (cookie !== undefined) {
      const found = this.store.session(cookie);
      if (!found)
        return this.failed(key, 'your session has ended; open your invite link again', true);
      // Browsers send Origin with every state-changing request and every
      // WebSocket upgrade; a cookie-carrying one without it is not from the app.
      if (
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        request.header('origin') === undefined
      ) {
        return {
          ok: false,
          error: new OpenBoardError(
            'forbidden',
            'a request authenticated by the session cookie must carry an Origin header',
          ),
        };
      }
      return {
        ok: true,
        caller: this.grantCaller(found.grant, 'session', name ?? found.record.name, found.hash),
      };
    }

    if (this.isLocal(request)) {
      try {
        return { ok: true, caller: headerActor() };
      } catch (error) {
        return { ok: false, error: error as OpenBoardError };
      }
    }
    return {
      ok: false,
      error: new OpenBoardError(
        'unauthorized',
        'this server is shared: sign in with an invite link, or send "Authorization: Bearer <token>"',
      ),
    };
  }

  /** Whether a caller's credentials still hold (for open sockets and in-process sessions). */
  stillValid(caller: Caller): boolean {
    if (caller.grantId === undefined) return true;
    if (!this.store.isActive(this.store.get(caller.grantId))) return false;
    return caller.sessionHash === undefined || this.store.sessionActive(caller.sessionHash);
  }
}

/** Header values are ASCII; clients percent-encode names (see actor.ts). */
function decodeName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** For `IncomingMessage` headers: one value per name. */
export function headerGetter(headers: IncomingHttpHeaders): (name: string) => string | undefined {
  return (name) => {
    const value = headers[name];
    return Array.isArray(value) ? value.join(', ') : value;
  };
}
