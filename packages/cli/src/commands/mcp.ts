import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { emptyBoard, OpenBoardError } from '@openboard/core';
import { actorForClient, runStdio, sessionFromEnv } from '@openboard/mcp';
import { connect } from '@openboard/sdk';
import { CliError } from '../lib/errors.js';
import type { CliIo } from '../lib/io.js';
import { println } from '../lib/io.js';
import { ensureServer, reconnectingApi, shared } from '../lib/mcp.js';
import { pluginUrl } from '../lib/plugins.js';
import { cliVersion, projectName, resolveRoot } from '../lib/project.js';
import { findRunningServer, projectPaths } from '../lib/server.js';
import {
  assertTokenTransport,
  ensureProjectDir,
  readBoardFiles,
  writeNewBoardFile,
} from '../lib/store.js';

export interface McpOptions {
  root?: string;
  /**
   * A remote OpenBoard to proxy to, with the token from `OPENBOARD_TOKEN`. No
   * local server is started, and identity and role come from the token's grant.
   */
  url?: string;
  /** Board used when a tool call names none. */
  board?: string;
  /** `--plugin` values for the background server this command may start. */
  plugins?: string[];
}

/** Send `console` output to stderr: stdout carries the protocol and nothing else. */
function consoleToStderr(io: CliIo): void {
  const write = (...args: unknown[]) => {
    io.stderr.write(`${format(...args)}\n`);
  };
  console.log = write;
  console.info = write;
  console.debug = write;
}

/**
 * Give a project without boards its `main` board, as `init` does, before a
 * server is started for it. Writing the file first means the server serves
 * it from its first request; `start` would only create it after listening.
 */
async function ensureMainBoard(root: string): Promise<void> {
  const paths = projectPaths(root);
  await ensureProjectDir(paths);
  if ((await readBoardFiles(paths)).length > 0 || (await findRunningServer(root))) return;
  try {
    await writeNewBoardFile(paths, emptyBoard({ id: 'main', name: projectName(root) }));
  } catch (error) {
    // Another process created it first.
    if (!(error instanceof OpenBoardError && error.code === 'board_exists')) throw error;
  }
}

/**
 * Serve the project's boards to an MCP client over stdio, through the
 * project's server. On the first use of the board, a server is started in the
 * background if none runs, and again if it goes away mid-session. Returns when
 * the client disconnects.
 */
export async function mcpCommand(io: CliIo, options: McpOptions = {}): Promise<number> {
  consoleToStderr(io);
  if (options.url !== undefined) return remoteMcp(io, options);
  const root = resolveRoot(io, options.root);

  // Nothing is created or started until a client actually uses the board: an
  // agent that has this server configured everywhere must not leave a board
  // file and a background process in every project it merely opens.
  const ensure = shared(async () => {
    await ensureMainBoard(root);
    // Plugin paths are resolved here, where the person typed them.
    const plugins = (options.plugins ?? []).map((spec) => fileURLToPath(pluginUrl(spec, io.cwd)));
    return ensureServer(root, io, undefined, plugins);
  });

  // One agent session per process. OPENBOARD_SESSION lets a client that also
  // reports hook activity use the same id, so both show as one session.
  const session = sessionFromEnv(io.env) ?? randomUUID();
  await runStdio({
    session,
    resolveApi: async (client) => {
      const server = await ensure();
      return reconnectingApi(actorForClient(client, io.env), server, ensure, client.session);
    },
    ...(options.board !== undefined ? { defaultBoard: options.board } : {}),
    version: cliVersion(),
  });
  return 0;
}

/**
 * `openboard mcp --url`: the stdio MCP server for a remote OpenBoard. Every
 * tool call goes to that server with the token from `OPENBOARD_TOKEN`; who the
 * agent is and what it may do come from the token's grant.
 */
async function remoteMcp(io: CliIo, options: McpOptions): Promise<number> {
  let url: URL;
  try {
    url = new URL(options.url as string);
  } catch {
    throw new CliError(`--url ${options.url}: not a URL`);
  }
  const token = io.env.OPENBOARD_TOKEN?.trim();
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!token) {
    println(
      io.stderr,
      `openboard: OPENBOARD_TOKEN is not set; a shared server refuses calls without it${local ? ' unless they come from its own machine' : ''}`,
    );
  }
  if (token) assertTokenTransport(url.toString());
  const session = sessionFromEnv(io.env) ?? randomUUID();
  await runStdio({
    session,
    resolveApi: async (client) => {
      const named = actorForClient(client, io.env);
      const api = token
        ? connect({ url: url.toString(), token, name: named.name, session: client.session })
        : connect({ url: url.toString(), actor: named, session: client.session });
      // Learn who the grant says we are, and fail early on a bad token.
      await api.whoami();
      return api;
    },
    ...(options.board !== undefined ? { defaultBoard: options.board } : {}),
    version: cliVersion(),
  });
  return 0;
}
