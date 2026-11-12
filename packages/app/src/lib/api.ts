/**
 * The REST surface the app uses (same origin). Every request carries the
 * actor headers; errors arrive as `{ error: { code, message } }`.
 */
import type {
  Actor,
  AnswerInput,
  Ask,
  Board,
  BoardSummary,
  ChangesOptions,
  ChangesResult,
  ClaimRequest,
  ClaimResult,
  Decision,
  HistoryOptions,
  HistoryResult,
  LayoutRequest,
  LayoutResult,
  ProjectConfig,
  Proposal,
  UndoRequest,
  UndoResult,
} from '@openboard/core';

export class ApiError extends Error {
  /** Server error code, or `unreachable` when the request never got an answer. */
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }

  get unreachable(): boolean {
    return this.code === 'unreachable';
  }
}

export interface ApiClient {
  listBoards(): Promise<BoardSummary[]>;
  createBoard(input: { name: string; description?: string }): Promise<BoardSummary>;
  layout(boardId: string, request: LayoutRequest): Promise<LayoutResult>;
  changes(boardId: string, options: ChangesOptions): Promise<ChangesResult>;
  /** What this server is and how agents reach it; null when the server does not say. */
  info(): Promise<ServerInfo | null>;
  decideProposal(boardId: string, proposalId: string, decision: Decision): Promise<Proposal>;
  answerAsk(boardId: string, askId: string, answer: AnswerInput): Promise<Ask>;
  cancelAsk(boardId: string, askId: string): Promise<Ask>;
  history(boardId: string, options: HistoryOptions): Promise<HistoryResult>;
  undo(boardId: string, request: UndoRequest): Promise<UndoResult>;
  getConfig(): Promise<ProjectConfig>;
  setConfig(config: ProjectConfig): Promise<ProjectConfig>;
  /**
   * The lineage of a board's live document, which the sync socket requires.
   * Null when the server does not say (an older server without lineages).
   */
  lineage(boardId: string): Promise<string | null>;
  claim(boardId: string, request: ClaimRequest): Promise<ClaimResult>;
  /** The board as it was right after `cursor`; aborted when `signal` fires. */
  snapshotAt(boardId: string, cursor: number, signal?: AbortSignal): Promise<Board>;
}

/** What a failed request was about, for wording its message. */
export type ApiSubject = 'proposal' | 'question' | 'batch' | 'settings' | 'request';

const SUBJECT_NAME: Record<ApiSubject, string> = {
  proposal: 'This proposal',
  question: 'This question',
  batch: 'This change',
  settings: 'The settings',
  request: 'This',
};

/**
 * A calm, plain sentence for a failed request, to show inline next to the
 * control that made it. The server's own message is kept for the cases where
 * it says something the person can act on (validation, an existing decision).
 */
export function calmMessage(error: unknown, subject: ApiSubject = 'request'): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : 'Something went wrong. Try again.';
  }
  const name = SUBJECT_NAME[subject];
  if (error.unreachable) return 'The server is not reachable right now. Try again in a moment.';
  switch (error.status) {
    case 403:
      return 'Only people can do this, and the server did not see this browser as a person.';
    case 404:
      return `${name} no longer exists. It may have been withdrawn or removed.`;
    case 409:
      if (subject === 'proposal') return 'Someone already decided on this proposal.';
      if (subject === 'question') return 'This question was already answered or withdrawn.';
      if (subject === 'batch') return 'This change was already undone.';
      return error.message;
    case 400:
      return error.message;
    default:
      return `${name} could not be completed: ${error.message}`;
  }
}

/** How an agent reaches this project's board server over MCP. */
export interface McpInfo {
  httpUrl: string;
  stdio: { command: string; args: string[] };
}

/** `GET /api/info`. Older servers do not have it. */
export interface ServerInfo {
  version: string;
  root: string;
  projectName: string;
  url: string;
  mcp?: McpInfo;
  /** The name of the person running the server, when it says. */
  user?: string;
}

const isString = (value: unknown): value is string => typeof value === 'string';

/** Read `GET /api/info` defensively: anything malformed is left out rather than trusted. */
export function parseServerInfo(raw: unknown): ServerInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const info: ServerInfo = {
    version: isString(r.version) ? r.version : '',
    root: isString(r.root) ? r.root : '',
    projectName: isString(r.projectName) ? r.projectName : '',
    url: isString(r.url) ? r.url : '',
  };
  if (isString(r.user) && r.user.trim()) info.user = r.user.trim().slice(0, 80);
  const mcp = r.mcp as Record<string, unknown> | undefined;
  const stdio = mcp?.stdio as Record<string, unknown> | undefined;
  if (
    mcp &&
    isString(mcp.httpUrl) &&
    stdio &&
    isString(stdio.command) &&
    stdio.command.length > 0 &&
    Array.isArray(stdio.args) &&
    stdio.args.every(isString)
  ) {
    info.mcp = { httpUrl: mcp.httpUrl, stdio: { command: stdio.command, args: [...stdio.args] } };
  }
  return info;
}

export function actorHeaders(actor: Actor): Record<string, string> {
  return {
    'x-openboard-actor-id': actor.id,
    'x-openboard-actor-name': encodeHeader(actor.name),
    'x-openboard-actor-kind': actor.kind,
  };
}

/** Header values must be ISO-8859-1; names with other characters are percent-encoded. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7E]*$/.test(value) ? value : encodeURIComponent(value);
}

export function createApiClient(getActor: () => Actor, base = ''): ApiClient {
  async function send(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await fetch(base + path, {
        method,
        headers: {
          ...actorHeaders(getActor()),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        ...(signal ? { signal } : {}),
      });
    } catch {
      if (signal?.aborted) throw new ApiError('aborted', 'The request was cancelled.', 0);
      throw new ApiError('unreachable', 'The OpenBoard server could not be reached.', 0);
    }
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await send(method, path, body, signal);
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const error = (json as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      // A proxy answering for a server that is not running reports a gateway error.
      if (!error && (response.status === 502 || response.status === 503 || response.status === 504))
        throw new ApiError('unreachable', 'The OpenBoard server could not be reached.', 0);
      throw new ApiError(
        typeof error?.code === 'string' ? error.code : 'http_error',
        typeof error?.message === 'string' ? error.message : `Request failed (${response.status}).`,
        response.status,
      );
    }
    if (json === undefined)
      throw new ApiError('bad_response', 'The server sent an empty response.', response.status);
    return json as T;
  }

  const board = (boardId: string) => `/api/boards/${encodeURIComponent(boardId)}`;

  return {
    listBoards: async () => {
      const result = await request<BoardSummary[] | { boards: BoardSummary[] }>(
        'GET',
        '/api/boards',
      );
      return Array.isArray(result) ? result : result.boards;
    },
    createBoard: (input) => request<BoardSummary>('POST', '/api/boards', input),
    layout: (boardId, layoutRequest) =>
      request<LayoutResult>(
        'POST',
        `/api/boards/${encodeURIComponent(boardId)}/layout`,
        layoutRequest,
      ),
    changes: (boardId, options) =>
      request<ChangesResult>('POST', `/api/boards/${encodeURIComponent(boardId)}/changes`, options),
    decideProposal: (boardId, proposalId, decision) =>
      request<Proposal>(
        'POST',
        `${board(boardId)}/proposals/${encodeURIComponent(proposalId)}/decide`,
        decision,
      ),
    answerAsk: (boardId, askId, answer) =>
      request<Ask>('POST', `${board(boardId)}/asks/${encodeURIComponent(askId)}/answer`, answer),
    cancelAsk: (boardId, askId) =>
      request<Ask>('POST', `${board(boardId)}/asks/${encodeURIComponent(askId)}/cancel`, {}),
    history: (boardId, options) =>
      request<HistoryResult>('POST', `${board(boardId)}/history`, options),
    undo: (boardId, undoRequest) =>
      request<UndoResult>('POST', `${board(boardId)}/undo`, undoRequest),
    getConfig: () => request<ProjectConfig>('GET', '/api/config'),
    lineage: async (boardId) => {
      // The listing names every board's lineage; it is much smaller than the board itself.
      const result = await request<unknown>('GET', '/api/boards');
      const list = Array.isArray(result)
        ? result
        : ((result as { boards?: unknown[] } | null)?.boards ?? []);
      for (const entry of list) {
        const b = entry as { id?: unknown; lineage?: unknown };
        if (b.id === boardId) return typeof b.lineage === 'string' ? b.lineage : null;
      }
      throw new ApiError('board_not_found', `There is no board "${boardId}".`, 404);
    },
    claim: (boardId, claimRequest) =>
      request<ClaimResult>('POST', `${board(boardId)}/claims`, claimRequest),
    snapshotAt: (boardId, cursor, signal) =>
      request<Board>(
        'GET',
        `${board(boardId)}/at/${Math.max(0, Math.floor(cursor))}`,
        undefined,
        signal,
      ),
    setConfig: (config) => request<ProjectConfig>('PUT', '/api/config', config),
    info: async () => {
      try {
        return parseServerInfo(await request<unknown>('GET', '/api/info'));
      } catch (error) {
        // A server without the route answers 404 (or something that is not JSON):
        // that is "no info", not a failure.
        if (error instanceof ApiError && (error.status === 404 || error.code === 'bad_response'))
          return null;
        throw error;
      }
    },
  };
}
