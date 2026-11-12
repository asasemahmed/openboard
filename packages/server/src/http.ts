/**
 * The HTTP surface (see "HTTP surface" in docs/ARCHITECTURE.md): the agent
 * API as JSON routes over `LocalBoardApi`, the access routes, and the web app.
 *
 * Routes are plain Hono routes, and the web app is served from the not-found
 * handler, so a route added later (for example `ALL /mcp`) takes precedence
 * over the app without reordering anything.
 *
 * Order of the checks on every request: Host and Origin (security.ts), then
 * authentication (auth.ts; in local mode only the actor headers), then mounted
 * handlers, then each route's permission (`route` below).
 */
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import {
  type AccessAction,
  API_ACTIONS,
  type ApiMethod,
  can,
  forbiddenMessage,
  OpenBoardError,
} from '@openboard/core';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { cleanName, SESSION_IDLE_MS } from './access.js';
import { ANONYMOUS_AGENT } from './actor.js';
import { Auth, type Caller, clientKey, readCookie, scrubSecrets, sessionCookie } from './auth.js';
import { type Boards, listing } from './boards.js';
import { errorMessage } from './fsutil.js';
import { checkRequest, type SecurityConfig } from './security.js';
import { LocalBoardApi } from './service.js';
import { resolveStatic } from './static.js';
import type { CallerInfo, MountHandler } from './types.js';

/** Request bodies above this size are refused with 413. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface HttpContext {
  boards: Boards;
  version: string;
  root: string;
  appDir?: string;
  security: () => SecurityConfig;
  log: (line: string) => void;
  /** The URL clients use, known once the server listens. */
  url: () => string;
  /** Extra fields for `GET /api/info`. */
  info?: () => Record<string, unknown>;
  /** Mounted handlers by path prefix; see `mountHandler`. */
  mounts: Map<string, MountHandler>;
  /** Authentication. Without it the server is in local mode. */
  auth?: Auth;
  /** The URL people use (shared mode); defaults to `url`. */
  publicUrl?: () => string;
}

/**
 * The permission a route needs: that of a `BoardApi` method (see
 * `API_ACTIONS`), `authenticated` (valid credentials, any role) or `public`
 * (no credentials; the route checks what it needs itself).
 */
export type RoutePermission = ApiMethod | 'authenticated' | 'public';

export interface RouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  permission: RoutePermission;
}

/** Each app's routes with their permissions. */
const ROUTE_TABLES = new WeakMap<object, RouteSpec[]>();

/** The routes of an app made by `createHttpApp`, with the permission each one needs. */
export function routeTable(app: object): readonly RouteSpec[] {
  return ROUTE_TABLES.get(app) ?? [];
}

/** The action a permission stands for, or null when any authenticated caller may. */
export function permissionAction(permission: RoutePermission): AccessAction | null {
  if (permission === 'authenticated' || permission === 'public') return null;
  return API_ACTIONS[permission];
}

type Env = { Variables: { caller: Caller }; Bindings: { incoming?: IncomingMessage } };
type Handler = (c: Context<Env>) => Response | Promise<Response>;

/** Request headers a mounted handler never sees from a remote caller in shared mode. */
const STRIPPED_FOR_MOUNTS = [
  'authorization',
  'cookie',
  'x-openboard-actor-id',
  'x-openboard-actor-kind',
];

/** Re-send the sliding session cookie at most this often. */
const COOKIE_REFRESH_MS = 24 * 60 * 60_000;

const API_PREFIXES = ['/api/', '/sync/'];
const RESERVED = ['/api', '/sync', '/mcp'];

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

const isReserved = (pathname: string) => RESERVED.some((prefix) => under(pathname, prefix));

const MOUNT_PATH = /^(\/[A-Za-z0-9._~-]+)+$/;

/** Add `handler` for `mountPath` and everything below it. Throws `invalid_request` or `conflict`. */
export function mountHandler(
  mounts: Map<string, MountHandler>,
  mountPath: string,
  handler: MountHandler,
): void {
  if (!MOUNT_PATH.test(mountPath)) {
    throw new OpenBoardError(
      'invalid_request',
      `cannot mount at ${JSON.stringify(mountPath)}: use a path such as "/mcp", without a trailing slash`,
    );
  }
  if (under(mountPath, '/api') || under(mountPath, '/sync')) {
    throw new OpenBoardError(
      'invalid_request',
      `cannot mount at ${mountPath}: it is a built-in route`,
    );
  }
  for (const existing of mounts.keys()) {
    if (under(mountPath, existing) || under(existing, mountPath)) {
      throw new OpenBoardError(
        'conflict',
        `cannot mount at ${mountPath}: ${existing} is already mounted`,
      );
    }
  }
  mounts.set(mountPath, handler);
}

function mountFor(mounts: Map<string, MountHandler>, pathname: string): MountHandler | undefined {
  for (const [prefix, handler] of mounts) if (under(pathname, prefix)) return handler;
  return undefined;
}

function errorResponse(c: Context, status: number, error: OpenBoardError): Response {
  const body = error.toJSON();
  // Never echo a token, ticket or cookie back, not even to the caller who sent it.
  body.error.message = scrubSecrets(body.error.message);
  const headers: Record<string, string> = {};
  if (error.code === 'unauthorized') headers['www-authenticate'] = 'Bearer realm="openboard"';
  const retry = (error.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
  if (error.code === 'rate_limited' && typeof retry === 'number') {
    headers['retry-after'] = String(retry);
  }
  return c.json(body, status as ContentfulStatusCode, headers);
}

function publicCaller(caller: Caller): CallerInfo {
  const info: CallerInfo = {
    actor: caller.actor,
    role: caller.role,
    via: caller.via,
    shared: caller.shared,
    anonymous: caller.anonymous,
  };
  if (caller.grantId !== undefined) info.grantId = caller.grantId;
  return info;
}

/** A path parameter of the matched route (always present once the route matched). */
function param(c: Context, name: string): string {
  return c.req.param(name) ?? '';
}

/** The JSON body, `{}` for an empty one. Throws `invalid_request` for anything that is not a JSON object. */
async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new OpenBoardError(
      'invalid_request',
      `request body is not valid JSON: ${errorMessage(error)}`,
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OpenBoardError('invalid_request', 'request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

export function createHttpApp(ctx: HttpContext): Hono<Env> {
  const app = new Hono<Env>();
  const table: RouteSpec[] = [];
  ROUTE_TABLES.set(app, table);
  const auth =
    ctx.auth ??
    new Auth({
      store: ctx.boards.access,
      shared: false,
      secureCookies: false,
      port: () => ctx.security().port,
    });
  const publicUrl = () => ctx.publicUrl?.() ?? ctx.url();
  /** When each session's cookie was last sent, by session hash (memory only). */
  const cookieIssued = new Map<string, number>();

  const requestInfo = (c: Context<Env>) => ({
    remoteAddress: c.env?.incoming?.socket.remoteAddress,
    host: c.req.header('host'),
    header: (name: string) => c.req.header(name),
    method: c.req.method,
  });

  const cookieFor = (value: string, expiresAt: string | undefined) => {
    const untilExpiry =
      expiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(expiresAt) - auth.now();
    return sessionCookie(auth.cookieName, value, {
      secure: auth.config.secureCookies,
      maxAgeSeconds: Math.min(SESSION_IDLE_MS, untilExpiry) / 1000,
    });
  };
  const clearedCookie = () =>
    sessionCookie(auth.cookieName, '', { secure: auth.config.secureCookies, maxAgeSeconds: 0 });

  app.onError((error, c) => {
    if (error instanceof OpenBoardError) return errorResponse(c, error.status, error);
    ctx.log(
      scrubSecrets(`internal error on ${c.req.method} ${c.req.path}: ${errorMessage(error)}`),
    );
    return errorResponse(c, 500, new OpenBoardError('internal', 'internal server error'));
  });

  app.use('*', async (c, next) => {
    const pathname = c.req.path;
    const verdict = checkRequest(
      ctx.security(),
      { host: c.req.header('host'), origin: c.req.header('origin') },
      API_PREFIXES.some((prefix) => pathname.startsWith(prefix)),
    );
    if (!verdict.ok) return errorResponse(c, 403, new OpenBoardError('forbidden', verdict.reason));
    await next();
    if (auth.shared) {
      // Invite links carry the token in the fragment, which browsers never put
      // in Referer; this keeps the rest of every URL out of it too, and keeps
      // the app out of other sites' frames.
      c.res.headers.set('referrer-policy', 'no-referrer');
      c.res.headers.set('x-frame-options', 'DENY');
      c.res.headers.set('x-content-type-options', 'nosniff');
    }
  });

  /** Routes anyone may call, in shared mode too; they check what they need themselves. */
  const isPublic = (method: string, pathname: string) =>
    (method === 'GET' && pathname === '/api/health') ||
    (method === 'POST' && (pathname === '/api/auth/session' || pathname === '/api/auth/logout'));

  // Authentication: every API request and every mounted route. Static app
  // files are public. In local mode this only reads the actor headers.
  app.use('*', async (c, next) => {
    const pathname = c.req.path;
    const mounted = mountFor(ctx.mounts, pathname) !== undefined;
    if (!(under(pathname, '/api') || mounted) || isPublic(c.req.method, pathname)) {
      return next();
    }
    let outcome = auth.authenticate(requestInfo(c));
    // A mounted route never failed on actor headers in local mode; keep it so.
    if (!outcome.ok && mounted && !auth.shared && outcome.error.code === 'invalid_request') {
      outcome = { ok: true, caller: auth.localCaller(ANONYMOUS_AGENT, true) };
    }
    if (!outcome.ok) {
      const response = errorResponse(c, outcome.error.status, outcome.error);
      if (outcome.clearCookie) response.headers.append('set-cookie', clearedCookie());
      return response;
    }
    const caller = outcome.caller;
    c.set('caller', caller);
    await next();
    // The cookie slides: re-sent at most once a day while the session is in use.
    const hash = caller.sessionHash;
    if (caller.via === 'session' && hash !== undefined && caller.grantId !== undefined) {
      const now = auth.now();
      if (now - (cookieIssued.get(hash) ?? 0) >= COOKIE_REFRESH_MS) {
        const value = readCookie(c.req.header('cookie'), auth.cookieName);
        const grant = auth.store.get(caller.grantId);
        if (value && grant && auth.store.sessionActive(hash)) {
          cookieIssued.set(hash, now);
          c.res.headers.append('set-cookie', cookieFor(value, grant.expiresAt));
        }
      }
    }
  });

  // Mounted handlers come before every route and the web app. Routes cannot
  // be added to a running Hono app, so mounts are looked up per request. The
  // handler gets the caller as its second argument; in shared mode a remote
  // caller's credentials and actor headers are taken off the request, so a
  // handler can neither log the token nor be misled by the headers.
  app.use('*', async (c, next) => {
    const handler = mountFor(ctx.mounts, c.req.path);
    if (!handler) return next();
    const caller = c.get('caller');
    let request = c.req.raw;
    if (auth.shared && caller.via !== 'local') {
      const headers = new Headers(request.headers);
      for (const name of STRIPPED_FOR_MOUNTS) headers.delete(name);
      request = new Request(request, { headers });
    }
    return handler(request, publicCaller(caller));
  });

  app.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          new OpenBoardError(
            'invalid_request',
            `request body is larger than ${MAX_BODY_BYTES} bytes`,
          ).toJSON(),
          413,
        ),
    }),
  );

  // `x-openboard-session` names the agent session a call belongs to (see live.ts).
  const api = (c: Context<Env>) => {
    const session = c.req.header('x-openboard-session');
    const caller = c.get('caller');
    return new LocalBoardApi(ctx.boards, caller.actor, ctx.log, {
      ...(session ? { session } : {}),
      // No actor headers at all: no presence, not remembered (see SessionOptions).
      ...(caller.anonymous ? { anonymous: true } : {}),
      role: caller.role,
      via: caller.via,
      ...(caller.grantId !== undefined ? { grantId: caller.grantId } : {}),
    });
  };

  /**
   * The one authorization step: every route is registered with the permission
   * it needs, and the caller's role is checked against it before the handler
   * runs (`forbidden`, naming the missing permission). The `LocalBoardApi`
   * behind the route checks the same table again.
   */
  const guard =
    (permission: RoutePermission): MiddlewareHandler<Env> =>
    async (c, next) => {
      const action = permissionAction(permission);
      const caller = c.get('caller');
      if (action !== null && !can(caller.role, action)) {
        throw new OpenBoardError('forbidden', forbiddenMessage(caller.role, action));
      }
      await next();
    };
  const route = (
    method: RouteSpec['method'],
    routePath: string,
    permission: RoutePermission,
    handler: Handler,
  ) => {
    table.push({ method, path: routePath, permission });
    if (permission === 'public') app.on(method, routePath, handler);
    else app.on(method, routePath, guard(permission), handler);
  };
  const get = (p: string, permission: RoutePermission, h: Handler) =>
    route('GET', p, permission, h);
  const post = (p: string, permission: RoutePermission, h: Handler) =>
    route('POST', p, permission, h);

  get('/api/health', 'public', (c) => {
    if (!auth.shared) {
      return c.json({ ok: true, version: ctx.version, pid: process.pid, root: ctx.root });
    }
    // Unauthenticated in shared mode: only the owner at this machine learns more
    // (the CLI matches `root` to find its running server).
    if (auth.isLocal(requestInfo(c))) {
      return c.json({
        ok: true,
        version: ctx.version,
        pid: process.pid,
        root: ctx.root,
        shared: true,
      });
    }
    return c.json({ ok: true, version: ctx.version, shared: true });
  });

  get('/api/info', 'authenticated', (c) => {
    const caller = c.get('caller');
    if (auth.shared && caller.role !== 'owner') {
      // Local paths, the local user name and launch commands are for the owner only.
      return c.json({
        version: ctx.version,
        projectName: path.basename(ctx.root),
        url: publicUrl(),
        shared: true,
      });
    }
    return c.json({
      version: ctx.version,
      root: ctx.root,
      projectName: path.basename(ctx.root),
      url: ctx.url(),
      ...ctx.info?.(),
      ...(auth.shared ? { shared: true, publicUrl: publicUrl() } : {}),
    });
  });

  // ── Access and sign-in ─────────────────────────────────────────────────────

  get('/api/whoami', 'whoami', async (c) => c.json(await api(c).whoami()));

  get('/api/access', 'listAccess', async (c) => c.json(await api(c).listAccess()));

  post('/api/access', 'grantAccess', async (c) =>
    c.json(
      await api(c).grantAccess(
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['grantAccess']>[0],
      ),
      201,
    ),
  );

  route('DELETE', '/api/access/:grant', 'revokeAccess', async (c) =>
    c.json(await api(c).revokeAccess(param(c, 'grant'))),
  );

  /**
   * Trade an invite token for a session cookie: `{ token, name? }`. A browser
   * endpoint, so it needs an `Origin` (which the check above has matched);
   * that also stops another site from signing a visitor in to a grant of its
   * own choosing. Any session the browser had ends first, and the new session
   * id is always made here, never taken from the client.
   */
  post('/api/auth/session', 'public', async (c) => {
    if (!auth.shared) {
      throw new OpenBoardError(
        'invalid_request',
        'this server is not shared; no sign-in is needed',
      );
    }
    if (c.req.header('origin') === undefined) {
      throw new OpenBoardError(
        'forbidden',
        'sign-in is for browsers: the request needs an Origin header',
      );
    }
    const info = requestInfo(c);
    const key = clientKey(info.remoteAddress, info.header);
    auth.checkThrottle(key);
    const body = await jsonBody(c);
    if (body.name !== undefined && typeof body.name !== 'string') {
      throw new OpenBoardError('invalid_request', '"name" must be a string');
    }
    const token = typeof body.token === 'string' ? body.token : '';
    const grant = token ? auth.store.verifyToken(token) : null;
    if (!grant) {
      auth.throttle.fail(key);
      throw new OpenBoardError(
        'unauthorized',
        'this invite link is not valid: it is wrong, expired or revoked',
      );
    }
    const previous = readCookie(c.req.header('cookie'), auth.cookieName);
    const old = previous ? auth.store.session(previous) : null;
    if (old) await auth.store.endSession(old.hash);
    const name = cleanName(body.name as string | undefined);
    const { sessionId, hash } = await auth.store.createSession(grant, name);
    cookieIssued.set(hash, auth.now());
    const caller = auth.grantCaller(grant, 'session', name, hash);
    const who = await new LocalBoardApi(ctx.boards, caller.actor, ctx.log, {
      role: caller.role,
      via: 'session',
      grantId: grant.id,
    }).whoami();
    const response = c.json(who, 200);
    response.headers.append('set-cookie', cookieFor(sessionId, grant.expiresAt));
    return response;
  });

  /** End the browser's session, if any, and clear the cookie. Always succeeds. */
  post('/api/auth/logout', 'public', async (c) => {
    const value = readCookie(c.req.header('cookie'), auth.cookieName);
    if (value !== undefined && auth.shared) {
      if (c.req.header('origin') === undefined) {
        throw new OpenBoardError(
          'forbidden',
          'a request authenticated by the session cookie must carry an Origin header',
        );
      }
      const found = auth.store.session(value);
      if (found) await auth.store.endSession(found.hash);
    }
    const response = c.json({ ok: true });
    if (auth.shared) response.headers.append('set-cookie', clearedCookie());
    return response;
  });

  /**
   * A single-use ticket for one sync socket (`/sync/:id?ticket=`), valid for a
   * minute, for WebSocket clients that cannot send `Authorization` or the
   * cookie on the upgrade. The long-lived token never goes in a URL.
   */
  post('/api/auth/ticket', 'authenticated', (c) => {
    const caller = c.get('caller');
    if (caller.grantId === undefined || caller.via === 'local') {
      throw new OpenBoardError(
        'invalid_request',
        'local connections need no ticket; a ticket stands in for an access token or session',
      );
    }
    const ticket = auth.store.issueTicket({
      grantId: caller.grantId,
      name: caller.actor.name,
      via: caller.via,
      ...(caller.sessionHash !== undefined ? { sessionHash: caller.sessionHash } : {}),
    });
    return c.json(ticket, 201);
  });

  // ── Boards ─────────────────────────────────────────────────────────────────

  get('/api/boards', 'listBoards', async (c) => c.json(await api(c).listBoards()));

  post('/api/boards', 'createBoard', async (c) => {
    const summary = await api(c).createBoard(
      (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['createBoard']>[0],
    );
    return c.json(listing(await ctx.boards.get(summary.id)), 201);
  });

  get('/api/boards/:id', 'getBoard', async (c) => {
    const board = await api(c).getBoard(param(c, 'id'));
    const room = await ctx.boards.get(param(c, 'id'));
    c.header('x-openboard-file-status', room.fileStatus);
    c.header('x-openboard-lineage', room.lineage);
    return c.json(board);
  });

  post('/api/boards/:id/outline', 'outline', async (c) =>
    c.json(await api(c).outline(param(c, 'id'), await jsonBody(c))),
  );

  post('/api/boards/:id/read', 'read', async (c) =>
    c.json(await api(c).read(param(c, 'id'), await jsonBody(c))),
  );

  post('/api/boards/:id/changes', 'changes', async (c) =>
    c.json(
      await api(c).changes(
        param(c, 'id'),
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['changes']>[1],
      ),
    ),
  );

  post('/api/boards/:id/apply', 'apply', async (c) =>
    c.json(
      await api(c).apply(
        param(c, 'id'),
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['apply']>[1],
      ),
    ),
  );

  get('/api/boards/:id/selection', 'selection', async (c) =>
    c.json(await api(c).selection(param(c, 'id'))),
  );

  post('/api/boards/:id/layout', 'layout', async (c) =>
    c.json(await api(c).layout(param(c, 'id'), await jsonBody(c))),
  );

  // ── Live work ──────────────────────────────────────────────────────────────

  post('/api/activity', 'reportActivity', async (c) =>
    c.json(
      await api(c).reportActivity(
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['reportActivity']>[0],
      ),
    ),
  );

  get('/api/sessions', 'sessions', async (c) => {
    const includeEnded = c.req.query('includeEnded');
    const maxTokens = c.req.query('maxTokens');
    const options: Record<string, unknown> = {};
    if (includeEnded !== undefined) options.includeEnded = includeEnded === 'true';
    if (maxTokens !== undefined) options.maxTokens = Number(maxTokens);
    return c.json(await api(c).sessions(options as Parameters<LocalBoardApi['sessions']>[0]));
  });

  post('/api/boards/:id/claims', 'claim', async (c) =>
    c.json(
      await api(c).claim(
        param(c, 'id'),
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['claim']>[1],
      ),
    ),
  );

  get('/api/boards/:id/at/:cursor', 'snapshotAt', async (c) => {
    const raw = param(c, 'cursor');
    if (!/^\d+$/.test(raw)) {
      throw new OpenBoardError('invalid_request', 'the cursor must be a whole number');
    }
    return c.json(await api(c).snapshotAt(param(c, 'id'), Number(raw)));
  });

  // ── Code and git ───────────────────────────────────────────────────────────

  post('/api/boards/:id/links', 'links', async (c) =>
    c.json(await api(c).links(param(c, 'id'), await jsonBody(c))),
  );

  post('/api/boards/:id/links/refresh', 'refreshLinks', async (c) =>
    c.json(
      await api(c).refreshLinks(
        param(c, 'id'),
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['refreshLinks']>[1],
      ),
    ),
  );

  get('/api/boards/:id/revisions', 'revisions', async (c) => {
    const limit = c.req.query('limit');
    return c.json(
      await api(c).revisions(param(c, 'id'), limit === undefined ? {} : { limit: Number(limit) }),
    );
  });

  get('/api/boards/:id/revisions/:rev', 'boardAtRevision', async (c) =>
    c.json(await api(c).boardAtRevision(param(c, 'id'), param(c, 'rev'))),
  );

  post('/api/boards/:id/diff', 'diffRevisions', async (c) =>
    c.json(
      await api(c).diffRevisions(
        param(c, 'id'),
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['diffRevisions']>[1],
      ),
    ),
  );

  post('/api/boards/:id/import', 'importInto', async (c) =>
    c.json(
      await api(c).importInto(
        param(c, 'id'),
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['importInto']>[1],
      ),
    ),
  );

  /** The exporter's output as a download, not JSON. */
  get('/api/boards/:id/export', 'exportBoard', async (c) => {
    const options: Record<string, unknown> = { format: c.req.query('format') ?? '' };
    const theme = c.req.query('theme');
    const diffFrom = c.req.query('diffFrom');
    if (theme !== undefined) options.theme = theme;
    if (diffFrom !== undefined) options.diffFrom = diffFrom;
    const result = await api(c).exportBoard(
      param(c, 'id'),
      options as Parameters<LocalBoardApi['exportBoard']>[1],
    );
    return c.body(result.text, 200, {
      'content-type': `${result.mime}; charset=utf-8`,
      'content-disposition': `attachment; filename="${result.filename}"`,
      'x-content-type-options': 'nosniff',
    });
  });

  // ── Settings ───────────────────────────────────────────────────────────────
  // "People only" routes check the actor kind; see the note in service.ts.

  get('/api/config', 'getConfig', async (c) => c.json(await api(c).getConfig()));

  route('PUT', '/api/config', 'setConfig', async (c) =>
    c.json(
      await api(c).setConfig(
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['setConfig']>[0],
      ),
    ),
  );

  // ── Review ─────────────────────────────────────────────────────────────────

  get('/api/boards/:id/proposals', 'proposals', async (c) => {
    const status = c.req.query('status');
    const maxTokens = c.req.query('maxTokens');
    const options: Record<string, unknown> = {};
    if (status !== undefined) options.status = status;
    if (maxTokens !== undefined) options.maxTokens = Number(maxTokens);
    return c.json(
      await api(c).proposals(param(c, 'id'), options as Parameters<LocalBoardApi['proposals']>[1]),
    );
  });

  post('/api/boards/:id/proposals/:pid/decide', 'decideProposal', async (c) =>
    c.json(
      await api(c).decideProposal(
        param(c, 'id'),
        param(c, 'pid'),
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['decideProposal']>[2],
      ),
    ),
  );

  post('/api/boards/:id/proposals/:pid/withdraw', 'withdrawProposal', async (c) =>
    c.json(await api(c).withdrawProposal(param(c, 'id'), param(c, 'pid'))),
  );

  // ── History ────────────────────────────────────────────────────────────────

  post('/api/boards/:id/history', 'history', async (c) =>
    c.json(await api(c).history(param(c, 'id'), await jsonBody(c))),
  );

  post('/api/boards/:id/undo', 'undo', async (c) =>
    c.json(
      await api(c).undo(
        param(c, 'id'),
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['undo']>[1],
      ),
    ),
  );

  // ── Conversation ───────────────────────────────────────────────────────────

  post('/api/boards/:id/comments', 'comment', async (c) =>
    c.json(
      await api(c).comment(
        param(c, 'id'),
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['comment']>[1],
      ),
      201,
    ),
  );

  post('/api/boards/:id/threads/:thread/resolve', 'resolveThread', async (c) => {
    const body = await jsonBody(c);
    const resolved = body.resolved === undefined ? true : body.resolved;
    return c.json(
      await api(c).resolveThread(param(c, 'id'), param(c, 'thread'), resolved as boolean),
    );
  });

  post('/api/boards/:id/inbox', 'inbox', async (c) =>
    c.json(await api(c).inbox(param(c, 'id'), await jsonBody(c))),
  );

  // ── Questions ──────────────────────────────────────────────────────────────

  post('/api/boards/:id/asks', 'ask', async (c) =>
    c.json(
      await api(c).ask(
        param(c, 'id'),
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['ask']>[1],
      ),
      201,
    ),
  );

  get('/api/boards/:id/asks', 'asks', async (c) => {
    const status = c.req.query('status');
    const maxTokens = c.req.query('maxTokens');
    const options: Record<string, unknown> = {};
    if (status !== undefined) options.status = status;
    if (maxTokens !== undefined) options.maxTokens = Number(maxTokens);
    return c.json(
      await api(c).asks(param(c, 'id'), options as Parameters<LocalBoardApi['asks']>[1]),
    );
  });

  /**
   * Long-poll with `?waitMs=`. Node's request timeout only covers receiving the
   * request, so it never cuts the wait; a client that disconnects aborts the
   * request signal, which ends the wait and releases its waiter.
   */
  get('/api/boards/:id/asks/:aid', 'askResult', async (c) => {
    const raw = c.req.query('waitMs');
    const waitMs = raw === undefined ? undefined : Number(raw);
    if (waitMs !== undefined && !(Number.isInteger(waitMs) && waitMs >= 0)) {
      throw new OpenBoardError('invalid_request', 'waitMs must be a whole number of milliseconds');
    }
    return c.json(
      await api(c).askResult(param(c, 'id'), param(c, 'aid'), {
        ...(waitMs !== undefined ? { waitMs } : {}),
        signal: c.req.raw.signal,
      }),
    );
  });

  post('/api/boards/:id/asks/:aid/answer', 'answerAsk', async (c) =>
    c.json(
      await api(c).answerAsk(
        param(c, 'id'),
        param(c, 'aid'),
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['answerAsk']>[2],
      ),
    ),
  );

  post('/api/boards/:id/asks/:aid/cancel', 'cancelAsk', async (c) =>
    c.json(await api(c).cancelAsk(param(c, 'id'), param(c, 'aid'))),
  );

  app.notFound(async (c) => {
    const pathname = c.req.path;
    const method = c.req.method;
    if (!isReserved(pathname) && (method === 'GET' || method === 'HEAD')) {
      if (ctx.appDir) {
        const file = await resolveStatic(ctx.appDir, pathname);
        if (file && method === 'HEAD') return c.body(null, 200, file.headers);
        if (file) return c.body(file.body, 200, file.headers);
      } else if (pathname === '/') {
        return c.text(
          'OpenBoard server. The web app is not being served (no app directory was given); the agent API is under /api.\n',
        );
      }
    }
    return c.json(
      new OpenBoardError('invalid_request', `no route for ${method} ${pathname}`).toJSON(),
      404,
    );
  });

  return app;
}
