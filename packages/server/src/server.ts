/**
 * `startServer`: one process, one project root. HTTP and the sync socket share
 * one `http.Server`; `server.json` announces the running server to the CLI and
 * to other processes until `close()` removes it.
 */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { type Actor, OpenBoardError } from '@openboard/core';
import { Auth, scrubSecrets } from './auth.js';
import { Boards } from './boards.js';
import { errorMessage, isErrno, writeFileAtomic } from './fsutil.js';
import { createHttpApp, mountHandler } from './http.js';
import { canonicalRoot, findProjectRoot, findRunningServer, projectPaths } from './paths.js';
import { PluginHost } from './plugins.js';
import { isLoopbackBind, type SecurityConfig } from './security.js';
import { LocalBoardApi } from './service.js';
import { SyncServer } from './sync.js';
import {
  type ApiOptions,
  DEFAULT_PORT,
  type MountHandler,
  type OpenBoardServer,
  type ServerInfo,
  type ServerOptions,
} from './types.js';

/** How many ports above the preferred one are tried when it is taken. */
const PORT_ATTEMPTS = 20;
const DEFAULT_HOST = '127.0.0.1';

/**
 * Roots with a server starting or running in this process. `server.json` is
 * written only once the port is known, so this covers two `startServer` calls
 * racing in one process.
 */
const activeRoots = new Map<string, string | null>();

/** This package's version, from its package.json (one level above both `src/` and `dist/`). */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function listenWithFallback(
  server: Server,
  preferred: number,
  host: string,
): Promise<number> {
  const attempts = preferred === 0 ? 1 : PORT_ATTEMPTS + 1;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await listen(server, preferred + i, host);
    } catch (error) {
      lastError = error;
      if (!isErrno(error, 'EADDRINUSE')) break;
    }
  }
  if (isErrno(lastError, 'EADDRINUSE')) {
    throw new OpenBoardError(
      'unavailable',
      `ports ${preferred}-${preferred + attempts - 1} on ${host} are all in use`,
    );
  }
  throw new OpenBoardError(
    'unavailable',
    `cannot listen on ${host}:${preferred}: ${errorMessage(lastError)}`,
  );
}

/** The host part of the URL clients should use for a bind address. */
function urlHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '') return '127.0.0.1';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '']);

/** The origin of a public URL, checked: http(s), no credentials, path, query or fragment. */
export function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpenBoardError('invalid_request', `publicUrl ${JSON.stringify(raw)} is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OpenBoardError('invalid_request', 'publicUrl must start with http:// or https://');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new OpenBoardError(
      'invalid_request',
      `publicUrl must be an origin such as https://board.example.com, without path, query or credentials (got ${JSON.stringify(raw)})`,
    );
  }
  return url;
}

/** Start a server for one project root. */
export async function startServer(options: ServerOptions = {}): Promise<OpenBoardServer> {
  const rawLog = options.log ?? (() => {});
  // Tokens, tickets and cookies never reach a log line, whoever wrote it.
  const log = (line: string) => rawLog(scrubSecrets(line));
  const root = canonicalRoot(options.root ?? findProjectRoot());
  const host = options.host ?? DEFAULT_HOST;
  const loopback = isLoopbackBind(host);
  if (!loopback && options.shared === false) {
    throw new OpenBoardError(
      'invalid_request',
      `refusing to listen on ${host} without shared mode: there is no unauthenticated remote mode; start in shared mode, or bind to 127.0.0.1`,
    );
  }
  const shared = options.shared === true || !loopback;
  if (options.publicUrl !== undefined) parsePublicUrl(options.publicUrl);
  if (shared && WILDCARD_HOSTS.has(host) && options.publicUrl === undefined) {
    throw new OpenBoardError(
      'invalid_request',
      `listening on ${host || 'every interface'} needs publicUrl, the URL people will use, so the server knows which Host and Origin to accept`,
    );
  }

  // Plugins are checked before anything starts: a clash stops the start.
  const plugins = new PluginHost(options.plugins ?? [], log);

  if (activeRoots.has(root)) {
    const url = activeRoots.get(root);
    throw new OpenBoardError(
      'conflict',
      url
        ? `a server for ${root} is already running at ${url} (pid ${process.pid})`
        : `a server for ${root} is already starting in this process`,
    );
  }
  activeRoots.set(root, null);
  try {
    return await start(root, host, options, log, plugins);
  } catch (error) {
    activeRoots.delete(root);
    throw error;
  }
}

async function start(
  root: string,
  host: string,
  options: ServerOptions,
  log: (line: string) => void,
  plugins: PluginHost,
): Promise<OpenBoardServer> {
  const paths = projectPaths(root);
  const loopback = isLoopbackBind(host);
  const shared = options.shared === true || !loopback;
  const running = await findRunningServer(root);
  if (running) {
    throw new OpenBoardError(
      'conflict',
      `a server for ${root} is already running at ${running.url} (pid ${running.pid})`,
      running,
    );
  }

  await mkdir(paths.dir, { recursive: true });
  const boards = new Boards(paths, {
    log,
    shared,
    plugins,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  await boards.start();
  try {
    await plugins.setup((plugin) => ({
      root,
      log: (line: string) => log(`plugin ${plugin.name}: ${line}`),
      api: (actor: Actor) => new LocalBoardApi(boards, actor, log),
    }));
  } catch (error) {
    await boards.close();
    throw error;
  }

  const security: SecurityConfig = { port: 0, checkHost: loopback };
  const mounts = new Map<string, MountHandler>();
  let url = '';
  let publicUrl = '';
  const secureCookies =
    options.publicUrl !== undefined && parsePublicUrl(options.publicUrl).protocol === 'https:';
  const auth = new Auth({
    store: boards.access,
    shared,
    secureCookies,
    port: () => security.port,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const extraInfo = options.info;
  const app = createHttpApp({
    boards,
    version: VERSION,
    root,
    ...(options.appDir ? { appDir: options.appDir } : {}),
    security: () => security,
    log,
    url: () => url,
    auth,
    publicUrl: () => publicUrl,
    ...(extraInfo === undefined
      ? {}
      : {
          info: typeof extraInfo === 'function' ? () => extraInfo({ url, root }) : () => extraInfo,
        }),
    mounts,
  });
  const sync = new SyncServer(boards, { security: () => security, log, auth });
  const server = createServer(getRequestListener(app.fetch));
  server.on('upgrade', (request, socket, head) => {
    if (!sync.handleUpgrade(request, socket, head)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  let port: number;
  try {
    port = await listenWithFallback(server, options.port ?? DEFAULT_PORT, host);
  } catch (error) {
    await sync.close();
    await boards.close();
    throw error;
  }
  security.port = port;

  url = `http://${urlHost(host)}:${port}`;
  publicUrl = options.publicUrl === undefined ? url : parsePublicUrl(options.publicUrl).origin;
  boards.publicUrl = publicUrl;
  if (shared) {
    const pub = new URL(publicUrl);
    security.shared = { host: pub.host.toLowerCase(), origin: pub.origin.toLowerCase() };
  }
  const info: ServerInfo = {
    pid: process.pid,
    port,
    url,
    root,
    version: VERSION,
    startedAt: new Date().toISOString(),
    ...(shared ? { shared: true, publicUrl } : {}),
  };
  await writeFileAtomic(paths.serverInfo, `${JSON.stringify(info, null, 2)}\n`);
  activeRoots.set(root, url);
  log(
    `openboard ${VERSION} serving ${root} at ${url}${shared ? ` in shared mode (public URL ${publicUrl})` : ''}`,
  );

  let closing: Promise<void> | null = null;
  const close = async () => {
    await sync.close();
    await boards.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    // Remove server.json only if it is still ours.
    try {
      const current = JSON.parse(await readFile(paths.serverInfo, 'utf8')) as {
        pid?: unknown;
        port?: unknown;
      };
      if (current.pid === info.pid && current.port === info.port)
        await rm(paths.serverInfo, { force: true });
    } catch {
      // Already gone or unreadable: nothing to clean up.
    }
    activeRoots.delete(root);
    log(`openboard server for ${root} stopped`);
  };

  return {
    info,
    url,
    root,
    shared,
    publicUrl,
    api: (actor: Actor, opts: ApiOptions = {}) =>
      new LocalBoardApi(boards, actor, log, {
        ...(opts.session !== undefined ? { session: opts.session } : {}),
        ...(opts.role !== undefined ? { role: opts.role } : {}),
        ...(opts.via !== undefined ? { via: opts.via } : {}),
        ...(opts.grantId !== undefined ? { grantId: opts.grantId } : {}),
      }),
    mount: (mountPath: string, handler: MountHandler) => mountHandler(mounts, mountPath, handler),
    close: () => {
      closing ??= close();
      return closing;
    },
  };
}
