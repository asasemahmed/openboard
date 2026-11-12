/**
 * `BoardApi` over HTTP.
 *
 * Isomorphic on purpose: it needs only `fetch`, `URL` and `AbortController`, so
 * the same client runs in Node, browsers, and edge runtimes. Routes follow the
 * "HTTP surface" table in docs/ARCHITECTURE.md.
 */
import {
  type AccessGrant,
  type AccessList,
  type ActivityEvent,
  type Actor,
  ActorSchema,
  type AnswerInput,
  type ApplyRequest,
  type ApplyResult,
  type ApplyTemplateRequest,
  type Ask,
  type AskInput,
  type AsksOptions,
  type AsksResult,
  type Board,
  type BoardApi,
  type BoardSummary,
  type ChangesOptions,
  type ChangesResult,
  type ClaimRequest,
  type ClaimResult,
  type Comment,
  type CommentInput,
  type CreateBoardInput,
  type Decision,
  type DiffRequest,
  type DiffResult,
  type ExportOptions,
  type ExportResult,
  type GrantAccessInput,
  type GrantAccessResult,
  type HistoryOptions,
  type HistoryResult,
  type ImportIntoResult,
  type ImportRequest,
  type InboxOptions,
  type InboxResult,
  type LayoutRequest,
  type LayoutResult,
  type LinksOptions,
  type LinksResult,
  OpenBoardError,
  type OpenBoardErrorCode,
  type Outline,
  type OutlineOptions,
  type ProjectConfig,
  type Proposal,
  type ProposalsResult,
  type ReadQuery,
  type ReadResult,
  type RefreshLinksRequest,
  type RevisionsOptions,
  type RevisionsResult,
  type SchemaOptions,
  type SchemaResult,
  type SelectionResult,
  type Session,
  type SessionsOptions,
  type SessionsResult,
  type TemplatesResult,
  type UndoRequest,
  type UndoResult,
  type WhoAmI,
} from '@openboard/core';

/** Requests that take longer than this fail with an `unavailable` error. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** How much longer than `waitMs` an `askResult` long-poll may take before it counts as timed out. */
export const LONG_POLL_GRACE_MS = 10_000;

/** Header names that carry the caller's actor. */
export const ACTOR_HEADERS = {
  id: 'x-openboard-actor-id',
  name: 'x-openboard-actor-name',
  kind: 'x-openboard-actor-kind',
} as const;

/** Header naming the agent session a call belongs to (see `ActivityEvent.session`). */
export const SESSION_HEADER = 'x-openboard-session';

export interface ConnectOptions {
  /** Base URL of a running server, such as `http://127.0.0.1:4747`. */
  url: string;
  /**
   * Local mode: everything done through the client is attributed to this
   * actor, sent in the `x-openboard-actor-*` headers. Required unless `token`
   * is given; with a token only its name is used (as `name`).
   */
  actor?: Actor;
  /**
   * An access token (`ob_...`) for a server in shared mode, sent as
   * `Authorization: Bearer`. The server then decides who the client is: the
   * first call asks it (`whoami`) and sets `actor`.
   */
  token?: string;
  /** The display name to show for a token's actor; its id and kind come from the grant. */
  name?: string;
  /** Custom `fetch`, for tests or runtimes without a global one. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * The agent session calls belong to, so the canvas shows them with that
   * session's activity. Sent as `x-openboard-session`.
   */
  session?: string;
}

/**
 * What `GET /api/health` returns. A shared server tells callers other than
 * the owner at its machine only `ok`, `version` and `shared`.
 */
export interface HealthInfo {
  ok: boolean;
  version: string;
  pid?: number;
  root?: string;
  shared?: boolean;
}

/** What `POST /api/auth/ticket` returns: a single-use ticket for one sync socket (`?ticket=`). */
export interface SyncTicket {
  ticket: string;
  expiresAt: string;
}

const ERROR_CODES: ReadonlySet<string> = new Set<OpenBoardErrorCode>([
  'board_not_found',
  'not_found',
  'board_exists',
  'invalid_request',
  'unauthorized',
  'forbidden',
  'conflict',
  'rate_limited',
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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  /** Safe to send twice. Only idempotent reads are retried, and only once. */
  idempotent: boolean;
  /** The JSON shape a successful response must have; `text` returns the raw body and its headers. */
  expect: 'object' | 'array' | 'text';
  /** Overrides the client's timeout for this request (long-polls). */
  timeoutMs?: number;
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

/** Stands in for a token's actor until the server has said who it is. */
const UNKNOWN_ACTOR: Actor = { id: 'unknown', kind: 'agent', name: 'Unknown' };

export class OpenBoardClient implements BoardApi {
  #actor: Actor;
  /** The server's base URL, normalized to end with `/`. */
  readonly url: string;
  readonly timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;
  readonly #token: boolean;
  #identity: Promise<WhoAmI> | null = null;

  constructor(options: ConnectOptions) {
    const token = options.token;
    if (token !== undefined && (typeof token !== 'string' || !/^\S+$/.test(token))) {
      throw new OpenBoardError('invalid_request', 'the access token must be a non-empty string');
    }
    if (options.actor === undefined && token === undefined) {
      throw new OpenBoardError(
        'invalid_request',
        'pass an actor (local mode) or a token (shared mode)',
      );
    }
    const fallback =
      options.name !== undefined ? { ...UNKNOWN_ACTOR, name: options.name } : UNKNOWN_ACTOR;
    const actor = ActorSchema.safeParse(options.actor ?? fallback);
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

    this.#actor = actor.data;
    this.url = base.toString();
    this.timeoutMs = timeoutMs;
    // Resolve the global lazily and call it unbound-free: some runtimes throw
    // "Illegal invocation" when `fetch` is called with another `this`.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#token = token !== undefined;
    if (token !== undefined) {
      // The grant decides the actor's id and kind; only a display name is sent.
      this.#headers = { accept: 'application/json', authorization: `Bearer ${token}` };
      const name = options.name ?? options.actor?.name;
      if (name !== undefined) this.#headers[ACTOR_HEADERS.name] = encodeURIComponent(name);
    } else {
      this.#headers = { accept: 'application/json', ...actorHeaders(this.#actor) };
    }
    if (options.session !== undefined) this.#headers[SESSION_HEADER] = options.session;
  }

  /**
   * Who calls go out as. With a token this is the grant's actor once the
   * server has answered the first call (`whoami`), and a placeholder before.
   */
  get actor(): Actor {
    return this.#actor;
  }

  // ── Access ────────────────────────────────────────────────────────────────

  /** Who the server takes this client to be. With a token, also sets `actor`. */
  async whoami(): Promise<WhoAmI> {
    const who = await this.#request<WhoAmI>({
      method: 'GET',
      path: 'api/whoami',
      idempotent: true,
      expect: 'object',
    });
    if (this.#token) this.#actor = who.actor;
    return who;
  }

  listAccess(): Promise<AccessList> {
    return this.#request({ method: 'GET', path: 'api/access', idempotent: true, expect: 'object' });
  }

  grantAccess(input: GrantAccessInput): Promise<GrantAccessResult> {
    return this.#request({
      method: 'POST',
      path: 'api/access',
      body: input,
      idempotent: false,
      expect: 'object',
    });
  }

  revokeAccess(grantId: string): Promise<AccessGrant> {
    return this.#request({
      method: 'DELETE',
      path: `api/access/${segment(grantId, 'grant id')}`,
      idempotent: true,
      expect: 'object',
    });
  }

  /**
   * A single-use ticket for one sync socket, valid for a minute, for
   * WebSocket clients that cannot send headers: `/sync/<board>?ticket=...`.
   */
  syncTicket(): Promise<SyncTicket> {
    return this.#request({
      method: 'POST',
      path: 'api/auth/ticket',
      idempotent: false,
      expect: 'object',
    });
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

  // ── Review ────────────────────────────────────────────────────────────────

  proposals(
    boardId: string,
    options: { status?: 'pending' | 'all'; maxTokens?: number } = {},
  ): Promise<ProposalsResult> {
    const query = new URLSearchParams();
    if (options.status !== undefined) query.set('status', options.status);
    if (options.maxTokens !== undefined) query.set('maxTokens', String(options.maxTokens));
    const qs = query.toString();
    return this.#request({
      method: 'GET',
      path: `${boardPath(boardId, 'proposals')}${qs ? `?${qs}` : ''}`,
      idempotent: true,
      expect: 'object',
    });
  }

  decideProposal(boardId: string, proposalId: string, decision: Decision): Promise<Proposal> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, `proposals/${segment(proposalId, 'proposal id')}/decide`),
      body: decision,
      idempotent: false,
      expect: 'object',
    });
  }

  withdrawProposal(boardId: string, proposalId: string): Promise<Proposal> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, `proposals/${segment(proposalId, 'proposal id')}/withdraw`),
      body: {},
      idempotent: false,
      expect: 'object',
    });
  }

  // ── History ───────────────────────────────────────────────────────────────

  history(boardId: string, options: HistoryOptions = {}): Promise<HistoryResult> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'history'),
      body: options,
      idempotent: true,
      expect: 'object',
    });
  }

  undo(boardId: string, request: UndoRequest): Promise<UndoResult> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'undo'),
      body: request,
      idempotent: false,
      expect: 'object',
    });
  }

  // ── Conversation ──────────────────────────────────────────────────────────

  comment(boardId: string, input: CommentInput): Promise<Comment> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'comments'),
      body: input,
      idempotent: false,
      expect: 'object',
    });
  }

  resolveThread(boardId: string, thread: string, resolved = true): Promise<Comment> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, `threads/${segment(thread, 'thread id')}/resolve`),
      body: { resolved },
      idempotent: false,
      expect: 'object',
    });
  }

  /** Marks the returned items seen unless `peek`, so only a peek is retried after a dropped connection. */
  /** With `waitMs`, a long-poll; its timeout is `waitMs` plus `LONG_POLL_GRACE_MS` (at least the client's). */
  inbox(boardId: string, options: InboxOptions = {}): Promise<InboxResult> {
    const spec: RequestSpec = {
      method: 'POST',
      path: boardPath(boardId, 'inbox'),
      body: options,
      idempotent: options.peek === true,
      expect: 'object',
    };
    if (options.waitMs !== undefined && options.waitMs > 0) {
      spec.timeoutMs = Math.max(this.timeoutMs, options.waitMs + LONG_POLL_GRACE_MS);
    }
    return this.#request(spec);
  }

  // ── Questions ─────────────────────────────────────────────────────────────

  ask(boardId: string, input: AskInput): Promise<Ask> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'asks'),
      body: input,
      idempotent: false,
      expect: 'object',
    });
  }

  asks(boardId: string, options: AsksOptions = {}): Promise<AsksResult> {
    const query = new URLSearchParams();
    if (options.status !== undefined) query.set('status', options.status);
    if (options.maxTokens !== undefined) query.set('maxTokens', String(options.maxTokens));
    const qs = query.toString();
    return this.#request({
      method: 'GET',
      path: `${boardPath(boardId, 'asks')}${qs ? `?${qs}` : ''}`,
      idempotent: true,
      expect: 'object',
    });
  }

  /** With `waitMs`, a long-poll; its timeout is `waitMs` plus `LONG_POLL_GRACE_MS` (at least the client's). */
  askResult(boardId: string, askId: string, options: { waitMs?: number } = {}): Promise<Ask> {
    const waitMs = options.waitMs;
    const qs = waitMs !== undefined ? `?waitMs=${encodeURIComponent(String(waitMs))}` : '';
    const spec: RequestSpec = {
      method: 'GET',
      path: `${boardPath(boardId, `asks/${segment(askId, 'question id')}`)}${qs}`,
      idempotent: true,
      expect: 'object',
    };
    if (waitMs !== undefined && waitMs > 0) {
      spec.timeoutMs = Math.max(this.timeoutMs, waitMs + LONG_POLL_GRACE_MS);
    }
    return this.#request(spec);
  }

  answerAsk(boardId: string, askId: string, answer: AnswerInput): Promise<Ask> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, `asks/${segment(askId, 'question id')}/answer`),
      body: answer,
      idempotent: false,
      expect: 'object',
    });
  }

  cancelAsk(boardId: string, askId: string): Promise<Ask> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, `asks/${segment(askId, 'question id')}/cancel`),
      body: {},
      idempotent: false,
      expect: 'object',
    });
  }

  // ── Live work ─────────────────────────────────────────────────────────────

  reportActivity(event: ActivityEvent): Promise<Session> {
    return this.#request({
      method: 'POST',
      path: 'api/activity',
      body: event,
      idempotent: false,
      expect: 'object',
    });
  }

  sessions(options: SessionsOptions = {}): Promise<SessionsResult> {
    const query = new URLSearchParams();
    if (options.includeEnded !== undefined) query.set('includeEnded', String(options.includeEnded));
    if (options.maxTokens !== undefined) query.set('maxTokens', String(options.maxTokens));
    const qs = query.toString();
    return this.#request({
      method: 'GET',
      path: `api/sessions${qs ? `?${qs}` : ''}`,
      idempotent: true,
      expect: 'object',
    });
  }

  claim(boardId: string, request: ClaimRequest): Promise<ClaimResult> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'claims'),
      body: request,
      idempotent: false,
      expect: 'object',
    });
  }

  snapshotAt(boardId: string, cursor: number): Promise<Board> {
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new OpenBoardError('invalid_request', 'the cursor must be a whole number');
    }
    return this.#request({
      method: 'GET',
      path: boardPath(boardId, `at/${cursor}`),
      idempotent: true,
      expect: 'object',
    });
  }

  // ── Code and git ──────────────────────────────────────────────────────────

  links(boardId: string, options: LinksOptions = {}): Promise<LinksResult> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'links'),
      body: options,
      idempotent: true,
      expect: 'object',
    });
  }

  refreshLinks(boardId: string, request: RefreshLinksRequest): Promise<ApplyResult> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'links/refresh'),
      body: request,
      idempotent: false,
      expect: 'object',
    });
  }

  revisions(boardId: string, options: RevisionsOptions = {}): Promise<RevisionsResult> {
    const qs = options.limit !== undefined ? `?limit=${options.limit}` : '';
    return this.#request({
      method: 'GET',
      path: `${boardPath(boardId, 'revisions')}${qs}`,
      idempotent: true,
      expect: 'object',
    });
  }

  boardAtRevision(boardId: string, rev: string): Promise<Board> {
    return this.#request({
      method: 'GET',
      path: boardPath(boardId, `revisions/${segment(rev, 'revision')}`),
      idempotent: true,
      expect: 'object',
    });
  }

  diffRevisions(boardId: string, request: DiffRequest): Promise<DiffResult> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'diff'),
      body: request,
      idempotent: true,
      expect: 'object',
    });
  }

  importInto(boardId: string, request: ImportRequest): Promise<ImportIntoResult> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'import'),
      body: request,
      idempotent: false,
      expect: 'object',
    });
  }

  async exportBoard(boardId: string, options: ExportOptions): Promise<ExportResult> {
    const query = new URLSearchParams({ format: options.format });
    if (options.theme !== undefined) query.set('theme', options.theme);
    if (options.diffFrom !== undefined) query.set('diffFrom', options.diffFrom);
    const raw = await this.#request<RawBody>({
      method: 'GET',
      path: `${boardPath(boardId, 'export')}?${query}`,
      idempotent: true,
      expect: 'text',
    });
    const filename =
      /filename="([^"]+)"/.exec(raw.disposition)?.[1] ?? `${boardId}.${options.format}`;
    return { text: raw.text, mime: raw.contentType.split(';')[0]?.trim() ?? '', filename };
  }

  // ── Types and templates ───────────────────────────────────────────────────

  schema(options: SchemaOptions = {}): Promise<SchemaResult> {
    const query = new URLSearchParams();
    if (options.board !== undefined) query.set('board', options.board);
    if (options.maxTokens !== undefined) query.set('maxTokens', String(options.maxTokens));
    const qs = query.toString();
    return this.#request({
      method: 'GET',
      path: `api/schema${qs ? `?${qs}` : ''}`,
      idempotent: true,
      expect: 'object',
    });
  }

  templates(): Promise<TemplatesResult> {
    return this.#request({
      method: 'GET',
      path: 'api/templates',
      idempotent: true,
      expect: 'object',
    });
  }

  applyTemplate(boardId: string, request: ApplyTemplateRequest): Promise<ApplyResult> {
    return this.#request({
      method: 'POST',
      path: boardPath(boardId, 'template'),
      body: request,
      idempotent: request.dryRun === true,
      expect: 'object',
    });
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  getConfig(): Promise<ProjectConfig> {
    return this.#request({ method: 'GET', path: 'api/config', idempotent: true, expect: 'object' });
  }

  setConfig(config: ProjectConfig): Promise<ProjectConfig> {
    return this.#request({
      method: 'PUT',
      path: 'api/config',
      body: config,
      idempotent: true,
      expect: 'object',
    });
  }

  async #request<T>(spec: RequestSpec): Promise<T> {
    // With a token, learn who we are before the first call, once.
    if (this.#token && spec.path !== 'api/whoami' && spec.path !== 'api/health') {
      this.#identity ??= this.whoami();
      try {
        await this.#identity;
      } catch (error) {
        this.#identity = null;
        throw error;
      }
    }
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
    const timeoutMs = spec.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        if (controller.signal.aborted) throw this.#timeout(target, timeoutMs);
        const reason = describeCause(error);
        const message = `could not reach the OpenBoard server at ${this.url} (${reason})`;
        if (isConnectionReset(error)) throw new ConnectionReset(message);
        throw new OpenBoardError('unavailable', message);
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (controller.signal.aborted) throw this.#timeout(target, timeoutMs);
        const message = `the connection to ${this.url} dropped while reading the response to ${where} (${describeCause(error)})`;
        if (isConnectionReset(error)) throw new ConnectionReset(message);
        throw new OpenBoardError('unavailable', message);
      }

      const parsed = parseJson(text);
      if (!response.ok) {
        throw toError(response.status, parsed, where, response.headers.get('retry-after'));
      }
      if (spec.expect === 'text') {
        const raw: RawBody = {
          text,
          contentType: response.headers.get('content-type') ?? '',
          disposition: response.headers.get('content-disposition') ?? '',
        };
        return raw as T;
      }
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

  #timeout(target: string, timeoutMs: number): OpenBoardError {
    return new OpenBoardError(
      'unavailable',
      `the OpenBoard server at ${this.url} did not answer within ${timeoutMs} ms (${target})`,
    );
  }
}

/**
 * A client for the server at `options.url`: bound to `options.actor` in local
 * mode, or to the grant of `options.token` in shared mode.
 */
export function connect(options: ConnectOptions): OpenBoardClient {
  return new OpenBoardClient(options);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RawBody {
  text: string;
  contentType: string;
  disposition: string;
}

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

/** One path segment for an id; ids are checked by the server. */
function segment(id: string, what: string): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new OpenBoardError('invalid_request', `a ${what} is required`);
  }
  return encodeURIComponent(id);
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toError(
  status: number,
  body: unknown,
  where: string,
  retryAfter: string | null = null,
): OpenBoardError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  if (error && typeof error.code === 'string' && ERROR_CODES.has(error.code)) {
    const message =
      typeof error.message === 'string' && error.message !== ''
        ? error.message
        : `${error.code} (HTTP ${status})`;
    return new OpenBoardError(error.code as OpenBoardErrorCode, message, error.details);
  }
  // A proxy in front of a shared server may answer these without our error body.
  if (status === 401) {
    return new OpenBoardError('unauthorized', `${where} needs valid credentials (HTTP 401)`);
  }
  if (status === 429) {
    const seconds = Number(retryAfter);
    return new OpenBoardError(
      'rate_limited',
      `${where} was refused: too many requests (HTTP 429)`,
      retryAfter !== null && Number.isFinite(seconds) ? { retryAfterSeconds: seconds } : undefined,
    );
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
