import type { OpenBoardServer, ProjectPaths, ServerInfo, ServerOptions } from './types.js';

export * from './layout/index.js';
export * from './types.js';

const pending = (): never => {
  throw new Error('not implemented');
};

/** Start a server for one project root. */
export function startServer(_options?: ServerOptions): Promise<OpenBoardServer> {
  return pending();
}

/**
 * The nearest ancestor of `cwd` that contains `.openboard/`, else the git root,
 * else `cwd` itself.
 */
export function findProjectRoot(_cwd?: string): string {
  return pending();
}

export function projectPaths(_root: string): ProjectPaths {
  return pending();
}

/** The server recorded for this root, or null when there is none or it is no longer running. */
export function findRunningServer(_root: string): Promise<ServerInfo | null> {
  return pending();
}
