import path from 'node:path';
import { actorForSession, createHttpHandler } from '@openboard/mcp';
import { boardUrl, openBrowser, waitForSignal } from '../lib/browser.js';
import { CliError } from '../lib/errors.js';
import { type CliIo, isDebug, println } from '../lib/io.js';
import { mcpLaunch, shellCommand } from '../lib/mcp.js';
import { loadPlugins } from '../lib/plugins.js';
import { cliActor, cliVersion, locateApp, projectName, resolveRoot } from '../lib/project.js';
import { findRunningServer, projectPaths, startServer } from '../lib/server.js';

export interface StartOptions {
  root?: string;
  port?: number;
  host?: string;
  /** Open the browser. Defaults to true; `--no-open` sets it to false. */
  open?: boolean;
  /** Open this board instead of the default view. */
  board?: string;
  /** Shared mode: everyone except this machine signs in (see docs/sharing.md). */
  share?: boolean;
  /** The URL people use to reach the server, such as an https tunnel or reverse proxy. */
  publicUrl?: string;
  /** Plugin modules to load, as given to `--plugin` (paths or package names). */
  plugins?: string[];
  /** Called once the server is up, with its URL. For tests and embedding. */
  onReady?: (url: string) => void;
}

/** Whether `host` names this machine only. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

/**
 * Start the server for a project in the foreground and keep it running until
 * SIGINT or SIGTERM. If one is already running, point at it and return.
 */
export async function startCommand(io: CliIo, options: StartOptions = {}): Promise<number> {
  const root = resolveRoot(io, options.root);
  const wantsBrowser = options.open !== false;

  const running = await findRunningServer(root);
  if (running) {
    println(io.stdout, `OpenBoard is already running at ${running.url}`);
    if (wantsBrowser) await openBrowser(io, boardUrl(running.url, options.board));
    return 0;
  }

  if (options.host !== undefined && !isLoopback(options.host) && !options.share) {
    throw new CliError(
      `binding to ${options.host} would let other machines reach the boards; add --share so everyone but this machine must sign in (there is no open remote mode)`,
    );
  }
  if (options.publicUrl !== undefined && !options.share) {
    throw new CliError('--public-url only applies to shared mode; add --share');
  }

  const plugins = options.plugins?.length ? await loadPlugins(options.plugins, io.cwd) : [];

  const app = locateApp();
  if (!app.built) {
    println(
      io.stderr,
      'openboard: the web app is not built (run `pnpm build`); serving the API only',
    );
  }

  const stdio = mcpLaunch(root);
  const server = await startServer({
    root,
    // `user` lets the web app suggest a display name for the person at this machine.
    info: ({ url }) => ({ user: cliActor(io.env).name, mcp: { httpUrl: `${url}/mcp`, stdio } }),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.share ? { shared: true } : {}),
    ...(options.publicUrl !== undefined ? { publicUrl: options.publicUrl } : {}),
    ...(plugins.length ? { plugins } : {}),
    ...(app.built && app.dir ? { appDir: app.dir } : {}),
    log: (line) => {
      if (isDebug(io)) println(io.stderr, line);
    },
  });

  // MCP over HTTP, in process. Each session acts as its caller: the grant's
  // actor and role for a remote caller, an actor named after the client for
  // the owner at this machine. Sessions stay bound to the caller that opened them.
  const mcp = createHttpHandler({
    resolveApi: (client) =>
      server.api(actorForSession(client, {}), {
        session: client.session,
        ...(client.caller
          ? {
              role: client.caller.role,
              via: client.caller.via,
              ...(client.caller.grantId ? { grantId: client.caller.grantId } : {}),
            }
          : {}),
      }),
    version: cliVersion(),
  });
  server.mount('/mcp', (request, caller) => mcp(request, caller));

  try {
    const api = server.api(cliActor(io.env));
    const boards = await api.listBoards();
    let boardId = options.board;
    if (boards.length === 0) {
      const created = await api.createBoard({ id: 'main', name: projectName(root) });
      boardId ??= created.id;
    } else if (boardId !== undefined && !boards.some((b) => b.id === boardId)) {
      throw new CliError(`no board "${boardId}" (boards: ${boards.map((b) => b.id).join(', ')})`);
    }

    const url = boardUrl(server.url, boardId);
    const boardsDir = path.relative(io.cwd, projectPaths(root).dir) || '.openboard';
    println(io.stdout, `OpenBoard is running at ${url}`);
    println(io.stdout, `Boards: ${boardsDir}`);
    if (plugins.length) await printPlugins(io, server.url);
    if (server.shared) {
      println(io.stdout, '');
      println(io.stdout, `Shared mode. People and agents reach it at ${server.publicUrl}`);
      println(io.stdout, 'Everyone must sign in with an invite, except you at this machine.');
      println(
        io.stdout,
        'Invite someone: openboard access invite (people), openboard access invite --agent (agents).',
      );
      if (
        server.publicUrl.startsWith('http://') &&
        !isLoopback(new URL(server.publicUrl).hostname)
      ) {
        println(
          io.stdout,
          'Warning: the public URL is plain http, so tokens and cookies cross the network unencrypted; put a TLS proxy or tunnel in front (see docs/sharing.md).',
        );
      }
    }
    println(io.stdout, '');
    println(io.stdout, 'Connect an agent (`openboard connect` shows the setup for each agent):');
    println(io.stdout, `  MCP over HTTP   ${server.url}/mcp`);
    println(io.stdout, `  MCP over stdio  ${shellCommand(stdio)}`);
    println(io.stdout, '');
    println(io.stdout, 'Press Ctrl+C to stop.');
    options.onReady?.(server.url);

    if (wantsBrowser && io.stdout.isTTY) await openBrowser(io, url);
    await (io.shutdown ?? waitForSignal)();
  } finally {
    await mcp.close();
    await server.close();
  }
  return 0;
}

/** The loaded plugins and their warnings, as the server reports them. */
async function printPlugins(io: CliIo, url: string): Promise<void> {
  try {
    const info = (await (await fetch(`${url}/api/info`)).json()) as {
      plugins?: Array<{ name: string; version?: string; warnings: string[] }>;
    };
    for (const plugin of info.plugins ?? []) {
      println(io.stdout, `Plugin: ${plugin.name}${plugin.version ? ` ${plugin.version}` : ''}`);
      for (const warning of plugin.warnings) println(io.stdout, `  warning: ${warning}`);
    }
  } catch {
    // The server runs; the list is only informative.
  }
}
