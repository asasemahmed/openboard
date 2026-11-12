/**
 * Where things live inside a project root, and how to find the server that is
 * already running for it.
 */
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { IdSchema, OpenBoardError } from '@openboard/core';
import type { ProjectPaths, ServerInfo } from './types.js';

export const BOARD_SUFFIX = '.board.json';

/** Throws `invalid_request` unless `id` is a valid board id. Run before any path is built from it. */
export function assertBoardId(id: string): string {
  if (!IdSchema.safeParse(id).success) {
    throw new OpenBoardError('invalid_request', `invalid board id ${JSON.stringify(id)}`);
  }
  return id;
}

export function isBoardId(id: string): boolean {
  return IdSchema.safeParse(id).success;
}

/** The board id for a file name such as `plan.board.json`, or null for any other file. */
export function boardIdFromFile(fileName: string): string | null {
  if (!fileName.endsWith(BOARD_SUFFIX)) return null;
  const id = fileName.slice(0, -BOARD_SUFFIX.length);
  return isBoardId(id) ? id : null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findUp(start: string, test: (dir: string) => boolean): string | null {
  let dir = start;
  for (;;) {
    if (test(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The nearest ancestor of `cwd` that contains `.openboard/`, else the git
 * root, else `cwd` itself.
 */
export function findProjectRoot(cwd: string = process.cwd()): string {
  const start = path.resolve(cwd);
  return (
    findUp(start, (dir) => isDir(path.join(dir, '.openboard'))) ??
    findUp(start, (dir) => existsSync(path.join(dir, '.git'))) ??
    start
  );
}

export function projectPaths(root: string): ProjectPaths {
  const resolved = path.resolve(root);
  const dir = path.join(resolved, '.openboard');
  const local = path.join(dir, '.local');
  return {
    root: resolved,
    dir,
    local,
    serverInfo: path.join(local, 'server.json'),
    boardFile: (boardId: string) => path.join(dir, `${assertBoardId(boardId)}${BOARD_SUFFIX}`),
  };
}

/** Runtime files of one board, all inside `.openboard/.local/`. */
export function localBoardFiles(paths: ProjectPaths, boardId: string) {
  assertBoardId(boardId);
  return {
    ydoc: path.join(paths.local, `${boardId}.ydoc`),
    changes: path.join(paths.local, `${boardId}.changes.jsonl`),
  };
}

/** Resolve symlinks (macOS temp dirs live behind `/var -> /private/var`) so roots compare reliably. */
export function canonicalRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as { code?: string }).code === 'EPERM';
  }
}

function readServerInfo(file: string): ServerInfo | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const info = raw as Partial<ServerInfo>;
    if (
      typeof info.pid !== 'number' ||
      typeof info.port !== 'number' ||
      typeof info.url !== 'string' ||
      typeof info.root !== 'string'
    ) {
      return null;
    }
    return info as ServerInfo;
  } catch {
    return null;
  }
}

const HEALTH_TIMEOUT_MS = 500;

/** The server recorded for this root, or null when there is none or it is no longer running. */
export async function findRunningServer(root: string): Promise<ServerInfo | null> {
  const paths = projectPaths(root);
  if (!existsSync(paths.serverInfo)) return null;
  const info = readServerInfo(paths.serverInfo);
  const stale = () => {
    rmSync(paths.serverInfo, { force: true });
    return null;
  };
  if (!info || !pidAlive(info.pid)) return stale();
  try {
    const response = await fetch(`${info.url}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return stale();
    const health = (await response.json()) as { root?: unknown };
    if (typeof health.root !== 'string') return stale();
    if (canonicalRoot(health.root) !== canonicalRoot(paths.root)) return stale();
    return info;
  } catch {
    return stale();
  }
}
