/**
 * `BoardApi` over HTTP.
 *
 * Isomorphic on purpose: it needs only `fetch`, `URL` and `AbortController`, so
 * the same client runs in Node, browsers, and edge runtimes. Routes follow the
 * "HTTP surface" table in docs/ARCHITECTURE.md.
 */
import {
  type Actor,
  ActorSchema,
  type ApplyRequest,
  type ApplyResult,
  type Board,
  type BoardApi,
  type BoardSummary,
  type ChangesOptions,
  type ChangesResult,
  type CreateBoardInput,
  type LayoutRequest,
  type LayoutResult,
  OpenBoardError,
  type OpenBoardErrorCode,
  type Outline,
  type OutlineOptions,
  type ReadQuery,
  type ReadResult,
  type SelectionResult,
} from '@openboard/core';

/** Requests that take longer than this fail with an `unavailable` error. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Header names that carry the caller's actor. */
export const ACTOR_HEADERS = {
  id: 'x-openboard-actor-id',
  name: 'x-openboard-actor-name',
  kind: 'x-openboard-actor-kind',
} as const;

export interface ConnectOptions {
  /** Base URL of a running server, such as `http://127.0.0.1:4747`. */
  url: string;
  /** Everything done through the client is attributed to this actor. */
  actor: Actor;
  /** Custom `fetch`, for tests or runtimes without a global one. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** What `GET /api/health` returns. */
export interface HealthInfo {
  ok: boolean;
  version: string;
  pid: number;
  root: string;
}

const ERROR_CODES: ReadonlySet<string> = new Set<OpenBoardErrorCode>([
  'board_not_found',
  'board_exists',
  'invalid_request',
  'forbidden',
  'conflict',
  'unavailable',
  'internal',
]);

/** Low-level failure codes that mean the connection dropped before a response. */
const RESET_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

const RETRY_DELAY_MS = 50;

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** Safe to send twice. Only idempotent reads are retried, and only once. */
  idempotent: boolean;
  /** The JSON shape a successful response must have. */
  expect: 'object' | 'array';
}

/**
 * Header values must be visible ASCII. Ids and kinds are ASCII by schema, but a
 * name can be anything, so the name is always sent through `encodeURIComponent`
 * and the server decodes it with `decodeURIComponent`. Encoding every name, not
 * only non-ASCII ones, keeps the rule unambiguous for names that contain `%`.
 */
export function actorHeaders(actor: Actor): Record<string, string> {
  return {
    [ACTOR_HEADERS.id]: actor.id,
    [ACTOR_HEADERS.name]: encodeURIComponent(actor.name),
    [ACTOR_HEADERS.kind]: actor.kind,
  };
}

export class OpenBoardClient implements BoardApi {
  readonly actor: Actor;
  /** The server's base URL, normalized to end with `/`. */
  readonly url: string;
  readonly timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  constructor(options: ConnectOptions) {
    const actor = ActorSchema.safeParse(options.actor);
    if (!actor.success) {
      throw new OpenBoardError('invalid_request', 'invalid actor for the OpenBoard client', {
        issues: actor.error.issues,
      });
    }
    let base: URL;
    try {
      base = new URL(options.url);
    } catch {
      throw new OpenBoardError(
        'invalid_request',
        `invalid OpenBoard server URL ${JSON.stringify(options.url)}`,
      );
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new OpenBoardError('invalid_request', `unsupported URL protocol in ${options.url}`);
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    base.search = '';
    base.hash = '';
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!(timeoutMs > 0)) {
      throw new OpenBoardError('invalid_request', 'timeoutMs must be a positive number');
    }

    this.actor = actor.data;
    this.url = base.toString();
    this.timeoutMs = timeoutMs;
    // Resolve the global lazily and call it unbound-free: some runtimes throw
    // "Illegal invocation" when `fetch` is called with another `this`.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#headers = { accept: 'application/json', ...actorHeaders(this.actor) };
  }

  /** Liveness and identity of the server. */
  health(): Promise<HealthInfo> {
    return this.#request({ method: 'GET', path: 'api/health', idempotent: true, expect: 'object' });
  }

  listBoards(): Promise<BoardSummary[]> {
    return this.#request({ method: 'GET', path: 'api/boards', idempotent: true, expect: 'array' });
  }

  createBoard(input: CreateBoardInput): Promise<BoardSummary> {
    return this.#request({
      method: 'POST',
      path: 'api/boards',
      body: input,
      idempotent: false,
      expect: 'object',
    });
  }

  getBoard(boardId: string): Promise<Board> {
    return this.#request({
      method: 'GET',
      path: boardPath(boardId),
      idempotent: true,
      expect: 'object',
    });
  }

  outline(boardId: string, options: OutlineOptions = {}): Promise<Outline> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'outline'),
      body: options,
      idempotent: true,
      expect: 'object',
    });
  }

  read(boardId: string, query: ReadQuery = {}): Promise<ReadResult> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'read'),
      body: query,
      idempotent: true,
      expect: 'object',
    });
  }

  changes(boardId: string, options: ChangesOptions): Promise<ChangesResult> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'changes'),
      body: options,
      idempotent: true,
      expect: 'object',
    });
  }

  apply(boardId: string, request: ApplyRequest): Promise<ApplyResult> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'apply'),
      body: request,
      idempotent: false,
      expect: 'object',
    });
  }

  selection(boardId: string): Promise<SelectionResult> {
    return this.#request({
      method: 'GET',
      path: boardPath(boardId, 'selection'),
      idempotent: true,
      expect: 'object',
    });
  }

  layout(boardId: string, request: LayoutRequest = {}): Promise<LayoutResult> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'layout'),
      body: request,
      idempotent: false,
      expect: 'object',
    });
  }

  async #request<T>(spec: RequestSpec): Promise<T> {
    const target = new URL(spec.path, this.url).toString();
    try {
      return await this.#attempt<T>(spec, target);
    } catch (error) {
      if (!spec.idempotent || !(error instanceof ConnectionReset)) throw unwrap(error);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      try {
        return await this.#attempt<T>(spec, target);
      } catch (retryError) {
        throw unwrap(retryError);
      }
    }
  }

  async #attempt<T>(spec: RequestSpec, target: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = { ...this.#headers };
    if (spec.body !== undefined) headers['content-type'] = 'application/json';
    const where = `${spec.method} ${target}`;
    try {
      let response: Response;
      try {
        response = await this.#fetch(target, {
          method: spec.method,
          headers,
          body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw this.#timeout(target);
        const reason = describeCause(error);
        const message = `could not reach the OpenBoard server at ${this.url} (${reason})`;
        if (isConnectionReset(error)) throw new ConnectionReset(message);
        throw new OpenBoardError('unavailable', message);
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (controller.signal.aborted) throw this.#timeout(target);
        const message = `the connection to ${this.url} dropped while reading the response to ${where} (${describeCause(error)})`;
        if (isConnectionReset(error)) throw new ConnectionReset(message);
        throw new OpenBoardError('unavailable', message);
      }

      const parsed = parseJson(text);
      if (!response.ok) throw toError(response.status, parsed, where);
      if (parsed === undefined) {
        throw new OpenBoardError(
          'internal',
          `unexpected response to ${where}: HTTP ${response.status} without a JSON body`,
        );
      }
      const isArray = Array.isArray(parsed);
      const isObject = typeof parsed === 'object' && parsed !== null && !isArray;
      if ((spec.expect === 'array' && !isArray) || (spec.expect === 'object' && !isObject)) {
        throw new OpenBoardError(
          'internal',
          `unexpected response to ${where}: expected a JSON ${spec.expect}`,
        );
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }

  #timeout(target: string): OpenBoardError {
    return new OpenBoardError(
      'unavailable',
      `the OpenBoard server at ${this.url} did not answer within ${this.timeoutMs} ms (${target})`,
    );
  }
}

/** A client bound to `options.actor` for the server at `options.url`. */
export function connect(options: ConnectOptions): OpenBoardClient {
  return new OpenBoardClient(options);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Marks a dropped connection so the caller may retry an idempotent read. */
class ConnectionReset extends Error {}

function unwrap(error: unknown): unknown {
  if (error instanceof ConnectionReset) return new OpenBoardError('unavailable', error.message);
  return error;
}

function boardPath(boardId: string, action?: string): string {
  if (typeof boardId !== 'string' || boardId.length === 0) {
    throw new OpenBoardError('invalid_request', 'a board id is required');
  }
  const base = `api/boards/${encodeURIComponent(boardId)}`;
  return action ? `${base}/${action}` : base;
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toError(status: number, body: unknown, where: string): OpenBoardError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  if (error && typeof error.code === 'string' && ERROR_CODES.has(error.code)) {
    const message =
      typeof error.message === 'string' && error.message !== ''
        ? error.message
        : `${error.code} (HTTP ${status})`;
    return new OpenBoardError(error.code as OpenBoardErrorCode, message, error.details);
  }
  const what = body === undefined ? 'a non-JSON' : 'an unrecognized';
  return new OpenBoardError(
    'internal',
    `unexpected response to ${where}: HTTP ${status} with ${what} error body`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `fetch` failures wrap the useful part in `cause`, sometimes twice. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < 5) {
    chain.push(current);
    current = isRecord(current) || current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

function codeOf(value: unknown): string | undefined {
  if (!(isRecord(value) || value instanceof Error)) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isConnectionReset(error: unknown): boolean {
  return causeChain(error).some((link) => {
    const code = codeOf(link);
    return code !== undefined && RESET_CODES.has(code);
  });
}

function describeCause(error: unknown): string {
  const chain = causeChain(error);
  const innermost = chain[chain.length - 1];
  const code = chain.map(codeOf).find((c) => c !== undefined);
  const message = innermost instanceof Error ? innermost.message : String(innermost);
  if (!message) return code ?? 'network error';
  if (code && !message.includes(code)) return `${code}: ${message}`;
  return message;
}
