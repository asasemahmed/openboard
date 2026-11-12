import { format } from 'node:util';
import { emptyBoard, OpenBoardError } from '@openboard/core';
import { actorForClient, runStdio } from '@openboard/mcp';
import type { CliIo } from '../lib/io.js';
import { ensureServer, reconnectingApi, shared } from '../lib/mcp.js';
import { cliVersion, projectName, resolveRoot } from '../lib/project.js';
import { findRunningServer, projectPaths } from '../lib/server.js';
import { ensureProjectDir, readBoardFiles, writeNewBoardFile } from '../lib/store.js';

export interface McpOptions {
  root?: string;
  /** Board used when a tool call names none. */
  board?: string;
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
  const root = resolveRoot(io, options.root);
  consoleToStderr(io);

  // Nothing is created or started until a client actually uses the board: an
  // agent that has this server configured everywhere must not leave a board
  // file and a background process in every project it merely opens.
  const ensure = shared(async () => {
    await ensureMainBoard(root);
    return ensureServer(root, io);
  });

  await runStdio({
    resolveApi: async (client) => {
      const server = await ensure();
      return reconnectingApi(actorForClient(client, io.env), server, ensure);
    },
    ...(options.board !== undefined ? { defaultBoard: options.board } : {}),
    version: cliVersion(),
  });
  return 0;
}
