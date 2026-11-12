import path from 'node:path';
import { actorForClient, createHttpHandler } from '@openboard/mcp';
import { boardUrl, openBrowser, waitForSignal } from '../lib/browser.js';
import { CliError } from '../lib/errors.js';
import { type CliIo, isDebug, println } from '../lib/io.js';
import { mcpLaunch, shellCommand } from '../lib/mcp.js';
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
  /** Called once the server is up, with its URL. For tests and embedding. */
  onReady?: (url: string) => void;
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
    info: ({ url }) => ({ mcp: { httpUrl: `${url}/mcp`, stdio } }),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(app.built && app.dir ? { appDir: app.dir } : {}),
    log: (line) => {
      if (isDebug(io)) println(io.stderr, line);
    },
  });

  // MCP over HTTP, in process: each session gets its own actor from its client name.
  const mcp = createHttpHandler({
    resolveApi: (client) => server.api(actorForClient(client, {})),
    version: cliVersion(),
  });
  server.mount('/mcp', mcp);

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
