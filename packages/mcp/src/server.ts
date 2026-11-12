/**
 * `createMcpServer`: the OpenBoard tools, resources and prompts on top of any
 * `BoardApi`.
 *
 * One server instance is one MCP session. It resolves its `BoardApi` once,
 * after the client has introduced itself, and remembers per board the cursor
 * up to which it has seen what others did. That cursor drives two things:
 * `board_changes` without `since`, and the one-line notice appended to a tool
 * result when people or other agents edited the board in the meantime. The
 * cursor only moves past edits by others once the session has been shown
 * them by `board_changes`, so a notice keeps pointing at real, unseen changes.
 */
import { readFileSync } from 'node:fs';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type ApplyRequest,
  type BoardApi,
  type BoardSummary,
  type ChangesOptions,
  type CreateBoardInput,
  type LayoutRequest,
  type Op,
  OpenBoardError,
  type ReadQuery,
  serializeBoard,
} from '@openboard/core';
import { z } from 'zod';
import type { ClientInfo } from './actor.js';
import { changeCount, formatApply, formatBoards, othersNotice, RESYNC_NOTICE } from './format.js';
import { mapCodebasePrompt, planWorkPrompt } from './prompts.js';
import {
  ANNOTATIONS,
  DESCRIPTIONS,
  INPUT_SCHEMAS,
  INSTRUCTIONS,
  TITLES,
  type ToolName,
} from './tools.js';

export interface McpServerOptions {
  /**
   * The board session to serve. Called once, lazily, after the client has
   * initialized, with what the client reported about itself.
   */
  resolveApi: (client: ClientInfo) => BoardApi | Promise<BoardApi>;
  /** Board used when a tool call names none. Otherwise: the only board, else `main`. */
  defaultBoard?: string;
  /** Version reported to clients. Defaults to this package's version. */
  version?: string;
}

/** This package's version, from its package.json (one level above `src/` and `dist/`). */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** A failure this package words itself; its message is shown as is. */
class ToolError extends Error {}

interface Reply {
  text: string;
  isError?: boolean;
  /** The board and cursor this call saw; enables the notice about edits by others. */
  saw?: { board: string; cursor: number };
}

/** Budget for the lookup behind the notice; only the count is used. */
const NOTICE_BUDGET = 100;

function isOpenBoardError(error: unknown): error is OpenBoardError {
  return (
    error instanceof OpenBoardError ||
    (error instanceof Error &&
      error.name === 'OpenBoardError' &&
      typeof (error as { code?: unknown }).code === 'string')
  );
}

/** "no board ..." -> "No board ..." without a trailing period, so it can be framed. */
function sentence(message: string): string {
  const trimmed = message.trim().replace(/[.\s]+$/, '');
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

class Session {
  #api: Promise<BoardApi> | undefined;
  #defaultBoard: string | undefined;
  readonly #cursors = new Map<string, number>();

  constructor(
    private readonly mcp: McpServer,
    private readonly options: McpServerOptions,
  ) {}

  api(): Promise<BoardApi> {
    if (!this.#api) {
      const reported = this.mcp.server.getClientVersion();
      const client: ClientInfo = { name: reported?.name ?? '' };
      if (reported?.version) client.version = reported.version;
      const pending = Promise.resolve().then(() => this.options.resolveApi(client));
      // A failed resolution is not cached: the next call tries again.
      pending.catch(() => {
        if (this.#api === pending) this.#api = undefined;
      });
      this.#api = pending;
    }
    return this.#api;
  }

  /** The board a call is about. */
  async board(api: BoardApi, requested: string | undefined): Promise<string> {
    if (requested) return requested;
    if (this.options.defaultBoard) return this.options.defaultBoard;
    if (this.#defaultBoard) return this.#defaultBoard;
    const boards = await api.listBoards();
    const id = defaultOf(boards);
    if (id === undefined) {
      throw new ToolError(
        boards.length === 0
          ? 'There are no boards yet. Create one with board_create.'
          : `Pass board: there are ${boards.length} boards and none is the default (${boards.map((b) => b.id).join(', ')}).`,
      );
    }
    this.#defaultBoard = id;
    return id;
  }

  /** The default board without throwing, for display. */
  defaultFor(boards: BoardSummary[]): string | undefined {
    return this.options.defaultBoard ?? this.#defaultBoard ?? defaultOf(boards);
  }

  cursor(board: string): number | undefined {
    return this.#cursors.get(board);
  }

  /** After `board_changes`: the session has now seen everything up to `cursor`. */
  caughtUp(board: string, cursor: number): void {
    this.#cursors.set(board, Math.max(this.#cursors.get(board) ?? 0, cursor));
  }

  /**
   * Record what a call saw and return the notice line, if others changed the
   * board since this session last caught up. Never throws.
   */
  async observe(api: BoardApi, board: string, cursor: number): Promise<string | undefined> {
    const last = this.#cursors.get(board);
    if (last === undefined || cursor <= last) {
      if (last === undefined) this.#cursors.set(board, cursor);
      return undefined;
    }
    try {
      const result = await api.changes(board, { since: last, maxTokens: NOTICE_BUDGET });
      if (result.resync) {
        this.#cursors.set(board, Math.max(cursor, result.cursor));
        return RESYNC_NOTICE;
      }
      const count = changeCount(result);
      if (count === 0) {
        this.#cursors.set(board, cursor);
        return undefined;
      }
      return othersNotice(count);
    } catch {
      return undefined;
    }
  }

  async run(fn: (api: BoardApi) => Promise<Reply>): Promise<CallToolResult> {
    let api: BoardApi | undefined;
    try {
      api = await this.api();
      const reply = await fn(api);
      let text = reply.text;
      if (reply.saw) {
        const notice = await this.observe(api, reply.saw.board, reply.saw.cursor);
        if (notice) text += `\n${notice}`;
      }
      return { content: [{ type: 'text', text }], ...(reply.isError ? { isError: true } : {}) };
    } catch (error) {
      return { content: [{ type: 'text', text: await this.explain(error, api) }], isError: true };
    }
  }

  /** The problem, and what to do next. */
  async explain(error: unknown, api: BoardApi | undefined): Promise<string> {
    if (error instanceof ToolError) return error.message;
    if (!isOpenBoardError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      return `Unexpected error: ${sentence(message.split('\n')[0] ?? '')}.`;
    }
    const message = sentence(error.message);
    switch (error.code) {
      case 'board_not_found': {
        let known = ' Call board_list to see the boards.';
        try {
          const boards = (await api?.listBoards()) ?? null;
          if (boards) {
            known =
              boards.length === 0
                ? ' There are no boards yet; create one with board_create.'
                : ` Boards: ${boards.map((b) => b.id).join(', ')}. Pass one of them as board.`;
          }
        } catch {
          // Keep the generic hint.
        }
        return `${message}.${known}`;
      }
      case 'unavailable':
        return `The OpenBoard server is not reachable (${message}). Start it with \`openboard start\` in the project, or connect through \`openboard mcp\`, which starts it; then retry.`;
      case 'invalid_request':
        return `Invalid request: ${message}.`;
      case 'board_exists':
        return `${message}. Use that board, or choose another id.`;
      case 'forbidden':
        return `Refused: ${message}.`;
      case 'conflict':
        return `Conflict: ${message}. Retry the call.`;
      default:
        return `The OpenBoard server failed: ${message}.`;
    }
  }
}

function defaultOf(boards: BoardSummary[]): string | undefined {
  if (boards.length === 1) return boards[0]?.id;
  return boards.some((b) => b.id === 'main') ? 'main' : undefined;
}

function tool<N extends ToolName>(name: N) {
  return {
    title: TITLES[name],
    description: DESCRIPTIONS[name],
    inputSchema: INPUT_SCHEMAS[name] as (typeof INPUT_SCHEMAS)[N],
    annotations: ANNOTATIONS[name],
  };
}

/** Drop keys whose value is `undefined`, so optional fields stay absent over HTTP and in core. */
function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** An MCP server exposing the boards behind `options.resolveApi`. One instance per session. */
export function createMcpServer(options: McpServerOptions): McpServer {
  const mcp = new McpServer(
    { name: 'openboard', title: 'OpenBoard', version: options.version ?? VERSION },
    { instructions: INSTRUCTIONS },
  );
  const session = new Session(mcp, options);

  mcp.registerTool('board_list', tool('board_list'), () =>
    session.run(async (api) => {
      const boards = await api.listBoards();
      return { text: formatBoards(boards, session.defaultFor(boards)) };
    }),
  );

  mcp.registerTool('board_create', tool('board_create'), (args) =>
    session.run(async (api) => {
      const created = await api.createBoard(defined(args) as CreateBoardInput);
      return {
        text: `Created board ${created.id} ${JSON.stringify(created.name)}. Pass board: ${JSON.stringify(created.id)} to work on it.`,
      };
    }),
  );

  mcp.registerTool('board_outline', tool('board_outline'), (args) =>
    session.run(async (api) => {
      const board = await session.board(api, args.board);
      const outline = await api.outline(board, defined({ maxTokens: args.maxTokens }));
      const text =
        outline.nodeCount === 0
          ? `${outline.text}\nThe board is empty; add to it with board_apply.`
          : outline.text;
      return { text, saw: { board, cursor: outline.cursor } };
    }),
  );

  mcp.registerTool('board_read', tool('board_read'), ({ board: requested, ...query }) =>
    session.run(async (api) => {
      const board = await session.board(api, requested);
      const result = await api.read(board, defined(query) as ReadQuery);
      return { text: result.text, saw: { board, cursor: result.cursor } };
    }),
  );

  mcp.registerTool('board_changes', tool('board_changes'), ({ board: requested, since, ...rest }) =>
    session.run(async (api) => {
      const board = await session.board(api, requested);
      const from = since ?? session.cursor(board);
      if (from === undefined) {
        return {
          text: `This session has not read board ${board} yet, so there is no cursor to continue from. Call board_outline first, or pass since (0 for all kept history).`,
        };
      }
      const options: ChangesOptions = { ...defined(rest), since: from };
      const result = await api.changes(board, options);
      session.caughtUp(board, result.cursor);
      return { text: result.text };
    }),
  );

  mcp.registerTool('board_selection', tool('board_selection'), (args) =>
    session.run(async (api) => {
      const board = await session.board(api, args.board);
      const result = await api.selection(board);
      const text =
        result.nodeIds.length === 0 && result.edgeIds.length === 0
          ? `${result.text}\nAsk the user to select it in the browser, or find it with board_read (text).`
          : result.text;
      return { text, saw: { board, cursor: result.cursor } };
    }),
  );

  mcp.registerTool('board_apply', tool('board_apply'), ({ board: requested, ops, ...rest }) =>
    session.run(async (api) => {
      const board = await session.board(api, requested);
      // Only the op kind was checked against the tool schema; core validates
      // each operation in full and reports problems by index.
      const request: ApplyRequest = { ...defined(rest), ops: ops as unknown as Op[] };
      const result = await api.apply(board, request);
      const { text, isError } = formatApply(result);
      return { text, isError, saw: { board, cursor: result.cursor } };
    }),
  );

  mcp.registerTool('board_layout', tool('board_layout'), ({ board: requested, ...rest }) =>
    session.run(async (api) => {
      const board = await session.board(api, requested);
      const result = await api.layout(board, defined(rest) as LayoutRequest);
      return {
        text: `Layout moved ${result.moved} node${result.moved === 1 ? '' : 's'}. Cursor ${result.cursor}.`,
        saw: { board, cursor: result.cursor },
      };
    }),
  );

  // ── Resources ──────────────────────────────────────────────────────────────

  const resourceError = async (error: unknown) =>
    new Error(await session.explain(error, undefined));

  mcp.registerResource(
    'boards',
    'openboard://boards',
    {
      title: 'Boards',
      description: 'The boards in this project, as JSON.',
      mimeType: 'application/json',
    },
    async (uri) => {
      try {
        const boards = await (await session.api()).listBoards();
        return {
          contents: [
            { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(boards, null, 2) },
          ],
        };
      } catch (error) {
        throw await resourceError(error);
      }
    },
  );

  mcp.registerResource(
    'board',
    new ResourceTemplate('openboard://boards/{id}', {
      list: async () => {
        const boards = await (await session.api()).listBoards();
        return {
          resources: boards.map((b) => ({
            uri: `openboard://boards/${encodeURIComponent(b.id)}`,
            name: b.id,
            title: b.name,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'Board',
      description:
        'A whole board as deterministic JSON. Unbudgeted: prefer the board_* tools in a conversation.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const raw = variables.id;
      const id = decodeURIComponent(String(Array.isArray(raw) ? raw[0] : raw));
      try {
        const board = await (await session.api()).getBoard(id);
        return {
          contents: [{ uri: uri.href, mimeType: 'application/json', text: serializeBoard(board) }],
        };
      } catch (error) {
        throw await resourceError(error);
      }
    },
  );

  // ── Prompts ────────────────────────────────────────────────────────────────

  mcp.registerPrompt(
    'map_codebase',
    {
      title: 'Map the codebase',
      description:
        "Map this repository's architecture onto the board: a frame per area, code nodes linked to files, edges for dependencies.",
      argsSchema: { board: z.string().optional().describe('Board id; default board if omitted') },
    },
    ({ board }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: mapCodebasePrompt(board) } }],
    }),
  );

  mcp.registerPrompt(
    'plan_work',
    {
      title: 'Plan work',
      description:
        'Turn a goal into a plan on the board: tasks, decisions, risks and questions, with dependencies.',
      argsSchema: {
        goal: z.string().describe('What to plan'),
        board: z.string().optional().describe('Board id; default board if omitted'),
      },
    },
    ({ goal, board }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: planWorkPrompt(goal, board) } }],
    }),
  );

  return mcp;
}
