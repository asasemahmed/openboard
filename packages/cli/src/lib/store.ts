/**
 * Boards, from wherever they are: the running server when there is one,
 * otherwise the board files in `.openboard/`.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Actor,
  applyOps,
  type Board,
  type BoardSummary,
  type CreateBoardInput,
  CreateBoardInputSchema,
  emptyBoard,
  IdSchema,
  OpenBoardError,
  parseBoard,
  serializeBoard,
  slugify,
} from '@openboard/core';
import { connect, type OpenBoardClient } from '@openboard/sdk';
import { CliError, isNodeError } from './errors.js';
import { type CliIo, println } from './io.js';
import { cliActor } from './project.js';
import { findRunningServer, type ProjectPaths, projectPaths, type ServerInfo } from './server.js';
import { templateOps } from './templates.js';

const BOARD_SUFFIX = '.board.json';

/** The part of `BoardApi` the CLI needs for whole boards. */
export interface BoardStore {
  /** `server` when talking to a running server, `files` when reading `.openboard/` directly. */
  readonly source: 'server' | 'files';
  listBoards(): Promise<BoardSummary[]>;
  createBoard(input: CreateBoardInput): Promise<BoardSummary>;
  getBoard(boardId: string): Promise<Board>;
}

export function summarize(board: Board): BoardSummary {
  const { schemaVersion: _v, actors: _a, nodes, edges, ...meta } = board;
  return {
    ...meta,
    nodeCount: Object.keys(nodes).length,
    edgeCount: Object.keys(edges).length,
  };
}

/** A board file that could not be read, with the first problem in it. */
export interface BoardFileProblem {
  file: string;
  message: string;
}

export interface BoardFile {
  file: string;
  /** Board id from the file name. */
  id: string;
  board?: Board;
  problem?: string;
}

/** Every `*.board.json` in the project, parsed. Missing directory: no boards. */
export async function readBoardFiles(paths: ProjectPaths): Promise<BoardFile[]> {
  let names: string[];
  try {
    names = await readdir(paths.dir);
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    throw error;
  }
  const files = names.filter((name) => name.endsWith(BOARD_SUFFIX)).sort();
  return Promise.all(
    files.map(async (name): Promise<BoardFile> => {
      const file = path.join(paths.dir, name);
      const id = name.slice(0, -BOARD_SUFFIX.length);
      try {
        return { file, id, board: parseBoard(await readFile(file, 'utf8')) };
      } catch (error) {
        return { file, id, problem: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

/** Create `.openboard/` and its git-ignored `.local/` if they are missing. Returns what it created. */
export async function ensureProjectDir(paths: ProjectPaths): Promise<string[]> {
  const created: string[] = [];
  if ((await mkdir(paths.dir, { recursive: true })) !== undefined) created.push(paths.dir);
  await mkdir(paths.local, { recursive: true });
  const ignore = path.join(paths.local, '.gitignore');
  try {
    await writeFile(ignore, '*\n', { flag: 'wx' });
    created.push(ignore);
  } catch (error) {
    if (!(isNodeError(error) && error.code === 'EEXIST')) throw error;
  }
  return created;
}

/** Write a new board file. Never overwrites: an existing file is a `board_exists` error. */
export async function writeNewBoardFile(paths: ProjectPaths, board: Board): Promise<string> {
  const file = paths.boardFile(board.id);
  try {
    await writeFile(file, serializeBoard(board), { flag: 'wx' });
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new OpenBoardError('board_exists', `board "${board.id}" already exists (${file})`);
    }
    throw error;
  }
  return file;
}

/** Boards read from and written to `.openboard/` directly. */
export class FileStore implements BoardStore {
  readonly source = 'files' as const;
  readonly paths: ProjectPaths;
  readonly #warn: (line: string) => void;
  readonly #actor: Actor;

  constructor(root: string, warn: (line: string) => void = () => {}, actor: Actor = cliActor()) {
    this.paths = projectPaths(root);
    this.#warn = warn;
    this.#actor = actor;
  }

  async listBoards(): Promise<BoardSummary[]> {
    const summaries: BoardSummary[] = [];
    for (const entry of await readBoardFiles(this.paths)) {
      if (entry.board) summaries.push(summarize(entry.board));
      else this.#warn(`skipping ${entry.file}: ${entry.problem}`);
    }
    return summaries;
  }

  async createBoard(input: CreateBoardInput): Promise<BoardSummary> {
    const parsed = CreateBoardInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new OpenBoardError(
        'invalid_request',
        `invalid board: ${issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'unknown problem'}`,
      );
    }
    const { id, name, description, template } = parsed.data;
    let board = emptyBoard({ id: id ?? slugify(name), name, description });
    if (template !== undefined) {
      // As the server does: the template's outer frame is titled after the board.
      const ops = await templateOps(this.paths.root, template, name);
      const outcome = applyOps(board, ops, { actor: this.#actor });
      if (!outcome.ok) {
        throw new OpenBoardError(
          'invalid_request',
          `template "${template}" does not apply: ${outcome.errors[0]?.message ?? 'unknown problem'}`,
        );
      }
      board = outcome.board;
    }
    await ensureProjectDir(this.paths);
    await writeNewBoardFile(this.paths, board);
    return summarize(board);
  }

  async getBoard(boardId: string): Promise<Board> {
    if (!IdSchema.safeParse(boardId).success) {
      throw new OpenBoardError('invalid_request', `invalid board id ${JSON.stringify(boardId)}`);
    }
    const file = this.paths.boardFile(boardId);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new OpenBoardError('board_not_found', `no board "${boardId}" in ${this.paths.dir}`);
      }
      throw error;
    }
    try {
      return parseBoard(text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new OpenBoardError('invalid_request', `${file}: ${reason}`);
    }
  }
}

export interface Session {
  root: string;
  /** The running server, or null. */
  server: ServerInfo | null;
  store: BoardStore;
  /** A client for the running server, when there is one. */
  client?: OpenBoardClient;
}

/**
 * A client for `url` as the person at this terminal: with `OPENBOARD_TOKEN`
 * when it is set (the server then says who that is), else as the local owner,
 * which only a server on this machine accepts.
 */
export function clientFor(io: CliIo, url: string): OpenBoardClient {
  const actor = cliActor(io.env);
  const token = io.env.OPENBOARD_TOKEN?.trim();
  if (token) assertTokenTransport(url);
  return token ? connect({ url, token, name: actor.name }) : connect({ url, actor });
}

/**
 * Refuse to send a token to `url` over plain http unless it is this machine:
 * https, or http to a loopback name only (as for `openboard hook`).
 */
export function assertTokenTransport(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`${url}: not a URL`);
  }
  if (parsed.protocol === 'https:') return;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    parsed.protocol === 'http:' &&
    (host === 'localhost' || host === '::1' || /^127\./.test(host))
  )
    return;
  throw new CliError(
    `refusing to send OPENBOARD_TOKEN to ${parsed.origin}: use https (plain http is only for this machine), so the token does not cross the network unencrypted`,
  );
}

/**
 * Talk to the remote server named by `--url`, else to the running server for
 * `root` if there is one, otherwise to the files.
 */
export async function openSession(io: CliIo, root: string): Promise<Session> {
  if (io.remoteUrl) {
    const client = clientFor(io, io.remoteUrl);
    return { root, server: null, store: { source: 'server', ...bindStore(client) }, client };
  }
  const server = await findRunningServer(root);
  if (server) {
    // The project's own server trusts this machine; a token meant for a remote one is not sent.
    const client = connect({ url: server.url, actor: cliActor(io.env) });
    return { root, server, store: { source: 'server', ...bindStore(client) }, client };
  }
  const store = new FileStore(
    root,
    (line) => println(io.stderr, `openboard: ${line}`),
    cliActor(io.env),
  );
  return { root, server: null, store };
}

function bindStore(client: OpenBoardClient): Omit<BoardStore, 'source'> {
  return {
    listBoards: () => client.listBoards(),
    createBoard: (input) => client.createBoard(input),
    getBoard: (id) => client.getBoard(id),
  };
}
