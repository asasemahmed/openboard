/**
 * The REST surface the app uses (same origin). Every request carries the
 * actor headers; errors arrive as `{ error: { code, message } }`.
 */
import type { Actor, BoardSummary, LayoutRequest, LayoutResult } from '@openboard/core';

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
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(base + path, {
        method,
        headers: {
          ...actorHeaders(getActor()),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError('unreachable', 'The OpenBoard server could not be reached.', 0);
    }
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
  };
}
