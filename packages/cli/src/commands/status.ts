import { existsSync } from 'node:fs';
import { type CliIo, println } from '../lib/io.js';
import { resolveRoot } from '../lib/project.js';
import { projectPaths } from '../lib/server.js';
import { openSession } from '../lib/store.js';
import { type BoardRow, printBoards } from './boards.js';

export interface StatusOptions {
  root?: string;
  json?: boolean;
}

export interface StatusReport {
  running: boolean;
  url: string | null;
  pid: number | null;
  port: number | null;
  root: string;
  initialized: boolean;
  boards: BoardRow[];
}

export async function getStatus(io: CliIo, root: string): Promise<StatusReport> {
  const session = await openSession(io, root);
  const boards = await session.store.listBoards();
  return {
    running: session.server !== null,
    url: session.server?.url ?? null,
    pid: session.server?.pid ?? null,
    port: session.server?.port ?? null,
    root,
    initialized: existsSync(projectPaths(root).dir),
    boards: boards.map(({ id, name, nodeCount, edgeCount, updatedAt }) => ({
      id,
      name,
      nodeCount,
      edgeCount,
      updatedAt,
    })),
  };
}

/** Whether a server is running for the project, and what boards it has. */
export async function statusCommand(io: CliIo, options: StatusOptions = {}): Promise<number> {
  const root = resolveRoot(io, options.root);
  const status = await getStatus(io, root);
  if (options.json) {
    println(io.stdout, JSON.stringify(status, null, 2));
    return 0;
  }
  println(
    io.stdout,
    status.running
      ? `OpenBoard is running at ${status.url} (pid ${status.pid})`
      : 'OpenBoard is not running.',
  );
  println(io.stdout, `Root: ${root}`);
  if (!status.initialized) {
    println(io.stdout, 'No .openboard directory here yet. Create one with: openboard init');
  } else if (status.boards.length === 0) {
    println(io.stdout, 'No boards yet. Create one with: openboard new <name>');
  } else {
    println(io.stdout);
    printBoards(io, status.boards);
  }
  return 0;
}
