import type { Actor, BoardApi } from '@openboard/core';

export const DEFAULT_PORT = 4747;

export interface ServerOptions {
  /** Project root. Boards live in `<root>/.openboard`. Defaults to `findProjectRoot()`. */
  root?: string;
  /** Preferred port. If it is taken, the next free port is used. */
  port?: number;
  /** Interface to bind. Defaults to loopback. */
  host?: string;
  /** Directory holding the built web app (its `index.html`). Without it, only the API is served. */
  appDir?: string;
  /** Called for each log line. Defaults to no logging. */
  log?: (line: string) => void;
  /**
   * Extra fields for `GET /api/info`, merged over the built-in ones. A function
   * is called per request with the server's URL and root, for values that
   * depend on the port.
   */
  info?:
    | Record<string, unknown>
    | ((server: { url: string; root: string }) => Record<string, unknown>);
}

/** Handles every request under a mounted path. */
export type MountHandler = (request: Request) => Response | Promise<Response>;

/** What `.openboard/.local/server.json` holds while a server is running. */
export interface ServerInfo {
  pid: number;
  port: number;
  url: string;
  root: string;
  version: string;
  startedAt: string;
}

export interface OpenBoardServer {
  readonly info: ServerInfo;
  readonly url: string;
  readonly root: string;
  /** An in-process session on this server, bound to `actor`. */
  api(actor: Actor): BoardApi;
  /**
   * Route `path` and everything below it (all methods) to `handler`, ahead of
   * the web app. The Host and Origin checks still apply. `path` is a fixed
   * prefix such as `/mcp`; `/api` and `/sync` cannot be mounted over.
   */
  mount(path: string, handler: MountHandler): void;
  /** Flush pending writes, close every connection, and remove `server.json`. */
  close(): Promise<void>;
}

/** Well-known locations inside a project root. */
export interface ProjectPaths {
  root: string;
  /** `<root>/.openboard` */
  dir: string;
  /** `<root>/.openboard/.local` */
  local: string;
  /** `<root>/.openboard/.local/server.json` */
  serverInfo: string;
  /** `<root>/.openboard/config.json` */
  config: string;
  /** `<root>/.openboard/<boardId>.board.json` */
  boardFile(boardId: string): string;
}
