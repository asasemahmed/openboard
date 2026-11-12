/**
 * The HTTP surface (see "HTTP surface" in docs/ARCHITECTURE.md): the agent
 * API as JSON routes over `LocalBoardApi`, and the web app.
 *
 * Routes are plain Hono routes, and the web app is served from the not-found
 * handler, so a route added later (for example `ALL /mcp`) takes precedence
 * over the app without reordering anything.
 */
import { type Actor, OpenBoardError } from '@openboard/core';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { actorFromHeaders } from './actor.js';
import { type Boards, listing } from './boards.js';
import { errorMessage } from './fsutil.js';
import { checkRequest, type SecurityConfig } from './security.js';
import { LocalBoardApi } from './service.js';
import { resolveStatic } from './static.js';

/** Request bodies above this size are refused with 413. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface HttpContext {
  boards: Boards;
  version: string;
  root: string;
  appDir?: string;
  security: () => SecurityConfig;
  log: (line: string) => void;
}

const API_PREFIXES = ['/api/', '/sync/'];
const RESERVED = ['/api', '/sync', '/mcp'];

const isReserved = (pathname: string) =>
  RESERVED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

function errorResponse(c: Context, status: number, error: OpenBoardError): Response {
  return c.json(error.toJSON(), status as ContentfulStatusCode);
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

export function createHttpApp(ctx: HttpContext): Hono<{ Variables: { actor: Actor } }> {
  const app = new Hono<{ Variables: { actor: Actor } }>();

  app.onError((error, c) => {
    if (error instanceof OpenBoardError) return errorResponse(c, error.status, error);
    ctx.log(`internal error on ${c.req.method} ${c.req.path}: ${errorMessage(error)}`);
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

  app.use('/api/*', async (c, next) => {
    c.set(
      'actor',
      actorFromHeaders((name) => c.req.header(name)),
    );
    await next();
  });

  const api = (c: Context<{ Variables: { actor: Actor } }>) =>
    new LocalBoardApi(ctx.boards, c.get('actor'), ctx.log);

  app.get('/api/health', (c) =>
    c.json({ ok: true, version: ctx.version, pid: process.pid, root: ctx.root }),
  );

  app.get('/api/boards', async (c) => c.json(await ctx.boards.list()));

  app.post('/api/boards', async (c) => {
    const summary = await api(c).createBoard(
      (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['createBoard']>[0],
    );
    return c.json(listing(await ctx.boards.get(summary.id)), 201);
  });

  app.get('/api/boards/:id', async (c) => {
    const room = await ctx.boards.get(c.req.param('id'));
    const board = await api(c).getBoard(room.id);
    c.header('x-openboard-file-status', room.fileStatus);
    return c.json(board);
  });

  app.post('/api/boards/:id/outline', async (c) =>
    c.json(await api(c).outline(c.req.param('id'), await jsonBody(c))),
  );

  app.post('/api/boards/:id/read', async (c) =>
    c.json(await api(c).read(c.req.param('id'), await jsonBody(c))),
  );

  app.post('/api/boards/:id/changes', async (c) =>
    c.json(
      await api(c).changes(
        c.req.param('id'),
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['changes']>[1],
      ),
    ),
  );

  app.post('/api/boards/:id/apply', async (c) =>
    c.json(
      await api(c).apply(
        c.req.param('id'),
        (await jsonBody(c)) as unknown as Parameters<LocalBoardApi['apply']>[1],
      ),
    ),
  );

  app.get('/api/boards/:id/selection', async (c) =>
    c.json(await api(c).selection(c.req.param('id'))),
  );

  app.post('/api/boards/:id/layout', async (c) =>
    c.json(await api(c).layout(c.req.param('id'), await jsonBody(c))),
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
