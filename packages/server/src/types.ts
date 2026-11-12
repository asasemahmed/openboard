import type { AccessVia, Actor, BoardApi, OpenBoardPlugin, Role } from '@openboard/core';

export const DEFAULT_PORT = 4747;

export interface ServerOptions {
  /** Project root. Boards live in `<root>/.openboard`. Defaults to `findProjectRoot()`. */
  root?: string;
  /** Preferred port. If it is taken, the next free port is used. */
  port?: number;
  /**
   * Interface to bind. Defaults to loopback. A non-loopback interface needs
   * `shared: true` (it implies it): there is no unauthenticated remote mode.
   */
  host?: string;
  /**
   * Shared mode: every request needs credentials (a bearer token, the session
   * cookie of an invite link, or a sync ticket), except static app files,
   * `GET /api/health`, sign-in and sign-out, and requests from the owner at
   * this machine (see `isLocalOwnerRequest`). Implied by a non-loopback `host`.
   */
  shared?: boolean;
  /**
   * The URL people use to reach the server, such as `https://board.example.com`
   * behind a tunnel or a reverse proxy with TLS: an origin without path, query
   * or credentials. In shared mode it is the browser origin and `Host` that are
   * accepted besides loopback, the base of invite links, and with https it
   * makes cookies `Secure`. Defaults to the server's own URL.
   */
  publicUrl?: string;
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
  /**
   * Milliseconds since the epoch, used for presence, sessions and claims.
   * Defaults to `Date.now`; tests inject their own.
   */
  clock?: () => number;
  /**
   * Plugins: more types, templates, exporters, importers and hooks. Only ever
   * passed here, in code; nothing is loaded from the project directory. Two
   * plugins may not share a name, a type, a template id or a format name.
   */
  plugins?: OpenBoardPlugin[];
}

/**
 * Who made a request, as the server established it. In local mode `actor`
 * comes from the `x-openboard-actor-*` headers and `role` is `owner`; in shared
 * mode the actor's id and kind come from the caller's grant.
 */
export interface CallerInfo {
  actor: Actor;
  role: Role;
  via: AccessVia;
  /** Whether the server runs in shared mode. */
  shared: boolean;
  /** A local caller that sent no actor headers at all. */
  anonymous: boolean;
  /** The grant behind a `token` or `session` caller. */
  grantId?: string;
}

/**
 * Handles every request under a mounted path. `caller` is the authenticated
 * caller of this request; in shared mode a request without valid credentials
 * never reaches the handler. Use `caller`, not headers, to decide who it is:
 * `server.api(caller.actor, { session, role: caller.role, via: caller.via,
 * grantId: caller.grantId })`.
 */
export type MountHandler = (request: Request, caller: CallerInfo) => Response | Promise<Response>;

/** Options of `OpenBoardServer.api`. */
export interface ApiOptions {
  /** The agent session calls belong to (see `ActivityEvent`). */
  session?: string;
  /**
   * The role to enforce. Omitted: `owner`, as for any in-process caller. A
   * handler acting for a remote caller passes the caller's role.
   */
  role?: Role;
  /** How the caller authenticated, for `whoami`. Defaults to `local`. */
  via?: AccessVia;
  /** The caller's grant: when it is revoked or expires, every call fails with `unauthorized`. */
  grantId?: string;
}

/** What `.openboard/.local/server.json` holds while a server is running. */
export interface ServerInfo {
  pid: number;
  port: number;
  url: string;
  root: string;
  version: string;
  startedAt: string;
  /** Set in shared mode. */
  shared?: boolean;
  /** Set in shared mode: the URL people use. */
  publicUrl?: string;
}

export interface OpenBoardServer {
  readonly info: ServerInfo;
  readonly url: string;
  readonly root: string;
  /** Whether the server runs in shared mode. */
  readonly shared: boolean;
  /** The URL people use to reach the server (`ServerOptions.publicUrl`, or `url`). */
  readonly publicUrl: string;
  /**
   * An in-process session on this server, bound to `actor`. `session` names
   * the agent session its calls belong to (see `ActivityEvent`); `role`, when
   * given, is enforced like a remote caller's.
   */
  api(actor: Actor, options?: ApiOptions): BoardApi;
  /**
   * Route `path` and everything below it (all methods) to `handler`, ahead of
   * the web app. The Host and Origin checks still apply, and in shared mode so
   * does authentication; the handler learns the caller from its second
   * argument. `path` is a fixed prefix such as `/mcp`; `/api` and `/sync`
   * cannot be mounted over.
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
  /** `<root>/.openboard/templates`: project templates, one `<name>.board.json` each */
  templates: string;
  /** `<root>/.openboard/<boardId>.board.json` */
  boardFile(boardId: string): string;
}
