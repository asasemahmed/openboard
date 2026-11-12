/** The list of boards on the server, shared by the home screen, switcher and palette. */
import type { BoardSummary } from '@openboard/core';
import { ApiError, createApiClient, type ServerInfo } from '../lib/api.js';
import { isString, readStored, writeStored } from '../lib/storage.js';
import { Emitter, useStoreValue, Value } from './emitter.js';
import { currentActor } from './identity.js';

export type BoardsSnapshot =
  | { status: 'loading'; boards: readonly BoardSummary[] }
  | { status: 'ready'; boards: readonly BoardSummary[] }
  | { status: 'error'; boards: readonly BoardSummary[]; error: ApiError };

export const api = createApiClient(currentActor);

class BoardsStore extends Emitter {
  private snapshot: BoardsSnapshot = { status: 'loading', boards: [] };
  private inflight: Promise<void> | null = null;

  readonly get = (): BoardsSnapshot => this.snapshot;

  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.snapshot.status === 'error') {
      this.snapshot = { status: 'loading', boards: this.snapshot.boards };
      this.emit();
    }
    this.inflight = api
      .listBoards()
      .then((boards) => {
        const sorted = [...boards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        this.snapshot = { status: 'ready', boards: sorted };
      })
      .catch((error: unknown) => {
        const apiError =
          error instanceof ApiError ? error : new ApiError('internal', String(error), 0);
        this.snapshot = { status: 'error', boards: this.snapshot.boards, error: apiError };
      })
      .finally(() => {
        this.inflight = null;
        this.emit();
      });
    return this.inflight;
  }

  async create(input: {
    name: string;
    description?: string;
    template?: string;
  }): Promise<BoardSummary> {
    const board = await api.createBoard(input);
    this.snapshot = {
      status: 'ready',
      boards: [board, ...this.snapshot.boards.filter((b) => b.id !== board.id)],
    };
    this.emit();
    return board;
  }
}

export const boards = new BoardsStore();

export function useBoards(): BoardsSnapshot {
  return useStoreValue(boards, boards.get);
}

const LAST_BOARD = 'lastBoard';

export function lastBoardId(): string | undefined {
  return readStored(LAST_BOARD, isString);
}

export function rememberBoard(id: string): void {
  writeStored(LAST_BOARD, id);
}

/** What the server said about itself (`GET /api/info`): project root, its user. Null until known. */
export const serverInfo = new Value<ServerInfo | null>(null);

let infoLoading: Promise<void> | null = null;

/** Read the server info once; later calls reuse the first answer. */
export function loadServerInfo(): Promise<void> {
  infoLoading ??= api
    .info()
    .then((info) => serverInfo.set(info))
    .catch(() => {
      infoLoading = null;
    });
  return infoLoading;
}
