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
 * The same notice line also counts unseen inbox items; which items are seen
 * is tracked by the server, so it survives reconnects.
 */
import { readFileSync } from 'node:fs';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type Actor,
  type ApplyRequest,
  type Ask,
  type BoardApi,
  type BoardSummary,
  type ChangesOptions,
  type CommentInput,
  type CreateBoardInput,
  type InboxItem,
  type LayoutRequest,
  MENTION_AGENTS,
  type Op,
  OpenBoardError,
  type ReadQuery,
  serializeBoard,
  type UndoRequest,
} from '@openboard/core';
import { z } from 'zod';
import type { ClientInfo } from './actor.js';
import {
  changeCount,
  formatApply,
  formatAsk,
  formatBoards,
  inboxCount,
  type NameOf,
  notice,
} from './format.js';
import { mapCodebasePrompt, planWorkPrompt } from './prompts.js';
import {
  ANNOTATIONS,
  DEFAULT_ASK_WAIT_SECONDS,
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
  /**
   * While `board_ask` waits, how often it sends a progress notification to a
   * client that asked for them (by sending a progress token). Defaults to 10 s.
   */
  progressIntervalMs?: number;
}

export const DEFAULT_PROGRESS_INTERVAL_MS = 10_000;

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
  /** The board this call was about; enables the notice line. */
  board?: string;
  /** The cursor this call saw; enables the part of the notice about edits by others. */
  cursor?: number;
  /** Leave the inbox out of the notice (for `board_inbox` itself). */
  noInbox?: boolean;
  /** Inbox items this result already told the agent about; not counted as new. */
  covered?: (item: InboxItem) => boolean;
}

/** What a tool call can do with the error it failed with, before the generic wording applies. */
type ErrorHint = (error: OpenBoardError) => string | undefined;

/** Budgets for the lookups behind the notice; only the counts are used. */
const NOTICE_BUDGET = 100;
const INBOX_NOTICE_BUDGET = 300;

/** The client cancelled the request; the result is never sent. */
class Cancelled extends Error {}

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
   * Record what a call saw and return how many changes by others it has not
   * been shown (`'resync'` when history no longer reaches back that far).
   * Never throws.
   */
  async unseenChanges(api: BoardApi, board: string, cursor: number): Promise<number | 'resync'> {
    const last = this.#cursors.get(board);
    if (last === undefined || cursor <= last) {
      if (last === undefined) this.#cursors.set(board, cursor);
      return 0;
    }
    try {
      const result = await api.changes(board, { since: last, maxTokens: NOTICE_BUDGET });
      if (result.resync) {
        this.#cursors.set(board, Math.max(cursor, result.cursor));
        return 'resync';
      }
      const count = changeCount(result);
      if (count === 0) this.#cursors.set(board, cursor);
      return count;
    } catch {
      return 0;
    }
  }

  /** Unseen inbox items, without marking them seen. Never throws. */
  async unseenInbox(api: BoardApi, board: string, covered: Reply['covered']): Promise<number> {
    try {
      const result = await api.inbox(board, { peek: true, maxTokens: INBOX_NOTICE_BUDGET });
      const known = covered ? result.items.filter(covered).length : 0;
      return Math.max(0, inboxCount(result) - known);
    } catch {
      return 0;
    }
  }

  async run(fn: (api: BoardApi) => Promise<Reply>, hint?: ErrorHint): Promise<CallToolResult> {
    let api: BoardApi | undefined;
    try {
      api = await this.api();
      const reply = await fn(api);
      let text = reply.text;
      if (reply.board !== undefined) {
        const board = reply.board;
        const ready = api;
        const [changes, inbox] = await Promise.all([
          reply.cursor !== undefined ? this.unseenChanges(ready, board, reply.cursor) : 0,
          reply.noInbox ? 0 : this.unseenInbox(ready, board, reply.covered),
        ]);
        const line = notice(changes, inbox);
        if (line) text += `\n${line}`;
      }
      return { content: [{ type: 'text', text }], ...(reply.isError ? { isError: true } : {}) };
    } catch (error) {
      return {
        content: [{ type: 'text', text: await this.explain(error, api, hint) }],
        isError: true,
      };
    }
  }

  /** The problem, and what to do next. */
  async explain(error: unknown, api: BoardApi | undefined, hint?: ErrorHint): Promise<string> {
    if (error instanceof ToolError) return error.message;
    if (error instanceof Cancelled) return 'Cancelled.';
    if (!isOpenBoardError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      return `Unexpected error: ${sentence(message.split('\n')[0] ?? '')}.`;
    }
    const specific = hint?.(error);
    if (specific !== undefined) return specific;
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
      case 'not_found':
      case 'conflict':
        return `${message}.`;
      default:
        return `The OpenBoard server failed: ${message}.`;
    }
  }
}

/** Display names of the actors on a board, looked up once per call and only when needed. */
function namesOn(api: BoardApi, board: string): () => Promise<NameOf> {
  let names: Promise<Record<string, Actor>> | undefined;
  return async () => {
    names ??= api.getBoard(board).then(
      (b) => b.actors,
      () => ({}),
    );
    const actors = await names;
    return (id) => {
      const actor = actors[id];
      return actor ? `${actor.name} (${actor.kind}, id ${id})` : id;
    };
  };
}

/**
 * Mentions as actor ids. Each one may be an id, a display name (any case, a
 * leading @ is dropped) or "agents". Unknown names are an error, because a
 * mention nobody receives would fail silently.
 */
async function resolveMentions(
  api: BoardApi,
  board: string,
  mentions: string[],
): Promise<string[]> {
  const wanted = mentions.map((m) => m.trim().replace(/^@/, '')).filter((m) => m !== '');
  if (wanted.every((m) => m === MENTION_AGENTS)) return [...new Set(wanted)];
  const actors = Object.values((await api.getBoard(board)).actors).filter(
    (a) => a.kind !== 'system',
  );
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const mention of wanted) {
    if (mention === MENTION_AGENTS || actors.some((a) => a.id === mention)) {
      ids.push(mention);
      continue;
    }
    const byName = actors.filter((a) => a.name.toLowerCase() === mention.toLowerCase());
    if (byName.length === 1 && byName[0]) ids.push(byName[0].id);
    else unknown.push(mention);
  }
  if (unknown.length > 0) {
    const known = actors
      .filter((a) => a.id !== api.actor.id)
      .map((a) => `${a.name} (${a.id})`)
      .join(', ');
    throw new ToolError(
      `Nothing was posted: ${unknown.map((m) => JSON.stringify(m)).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not anyone on this board. Mention by id or name${known ? `: ${known}` : ''}, or "${MENTION_AGENTS}" for every agent. Replying in a thread notifies its participants without a mention.`,
    );
  }
  return [...new Set(ids)];
}

interface WaitContext {
  signal: AbortSignal;
  progressToken?: string | number;
  sendProgress: (progress: number, total: number) => Promise<void>;
  intervalMs: number;
}

/**
 * Wait up to `waitMs` for a question to be answered or cancelled, sending
 * progress notifications while it waits when the client asked for them, and
 * giving up at once when the client cancels the request.
 */
async function waitForAnswer(
  api: BoardApi,
  board: string,
  askId: string,
  waitMs: number,
  context: WaitContext,
): Promise<{ ask: Ask; waitedSeconds: number }> {
  const started = Date.now();
  const total = waitMs / 1000;
  const report = () => {
    if (context.progressToken === undefined) return;
    const elapsed = Math.min(total, (Date.now() - started) / 1000);
    context.sendProgress(elapsed, total).catch(() => {});
  };
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Cancelled());
    if (context.signal.aborted) onAbort();
    else context.signal.addEventListener('abort', onAbort, { once: true });
  });
  report();
  const timer =
    context.progressToken === undefined ? undefined : setInterval(report, context.intervalMs);
  try {
    // The in-process API also ends its wait on the signal; over HTTP the
    // race below returns at once and the long-poll ends on its own.
    const options: { waitMs: number; signal: AbortSignal } = { waitMs, signal: context.signal };
    const ask = await Promise.race([api.askResult(board, askId, options), aborted]);
    return { ask, waitedSeconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    if (timer !== undefined) clearInterval(timer);
    context.signal.removeEventListener('abort', onAbort);
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
      return { text, board, cursor: outline.cursor };
    }),
  );

  mcp.registerTool('board_read', tool('board_read'), ({ board: requested, ...query }) =>
    session.run(async (api) => {
      const board = await session.board(api, requested);
      const result = await api.read(board, defined(query) as ReadQuery);
      return { text: result.text, board, cursor: result.cursor };
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
      return { text: result.text, board };
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
      return { text, board, cursor: result.cursor };
    }),
  );

  mcp.registerTool('board_apply', tool('board_apply'), ({ board: requested, ops, ...rest }) =>
    session.run(async (api) => {
      const board = await session.board(api, requested);
      // Only the op kind was checked against the tool schema; core validates
      // each operation in full and reports problems by index.
      const request: ApplyRequest = { ...defined(rest), ops: ops as unknown as Op[] };
      const result = await api.apply(board, request);
      const { text, isError } = formatApply(result, ops.length);
      return { text, isError, board, cursor: result.cursor };
    }),
  );

  mcp.registerTool('board_layout', tool('board_layout'), ({ board: requested, ...rest }) =>
    session.run(async (api) => {
      const board = await session.board(api, requested);
      const result = await api.layout(board, defined(rest) as LayoutRequest);
      return {
        text: `Layout moved ${result.moved} node${result.moved === 1 ? '' : 's'}. Cursor ${result.cursor}.`,
        board,
        cursor: result.cursor,
      };
    }),
  );

  mcp.registerTool('board_inbox', tool('board_inbox'), ({ board: requested, ...rest }) =>
    session.run(async (api) => {
      const board = await session.board(api, requested);
      const result = await api.inbox(board, defined(rest));
      const lines = [result.text];
      if (result.openAsks > 0) {
        try {
          const open = await api.asks(board, { status: 'open', maxTokens: 50_000 });
          const mine = open.asks.filter((ask) => ask.author === api.actor.id);
          if (mine.length > 0) {
            lines.push(
              'Your open questions (wait on one with board_ask {askId}):',
              ...mine.map((ask) => `  ${ask.id} ${JSON.stringify(ask.question)}`),
            );
          }
        } catch {
          // The count above still stands.
        }
      }
      const kinds = new Set(result.items.map((item) => item.kind));
      if (kinds.has('mention') || kinds.has('reply')) {
        lines.push(
          'Answer people with board_comment {thread, body}; once a thread is handled, close it with board_comment {resolve: <thread>}.',
        );
      }
      const turnedDown = result.items.some(
        (item) =>
          item.kind === 'decision' &&
          /\((rejected|partly_accepted)\)|could not apply/.test(item.summary),
      );
      if (turnedDown) {
        lines.push(
          'Rejected items are not on the board: read the note and adjust. Do not send them again unchanged.',
        );
      }
      if (kinds.has('undone')) {
        lines.push('Someone undid a change of yours: do not redo it without asking.');
      }
      if (rest.peek && result.items.length > 0) lines.push('Peek: these items stay unseen.');
      return { text: lines.join('\n'), board, noInbox: true };
    }),
  );

  mcp.registerTool('board_comment', tool('board_comment'), (args) =>
    session.run(
      async (api) => {
        const board = await session.board(api, args.board);
        if (args.resolve !== undefined) {
          if (args.body !== undefined || args.thread !== undefined || args.mentions !== undefined) {
            throw new ToolError(
              'Pass either resolve (to close a thread) or body (to comment), not both. Nothing was changed.',
            );
          }
          // Look first, so resolving twice says who did it instead of pretending.
          const current = await api.getBoard(board).catch(() => undefined);
          const found = current?.comments?.[args.resolve];
          const before = found && (current?.comments?.[found.thread] ?? found);
          if (before?.resolvedAt !== undefined) {
            const by = before.resolvedBy && current?.actors[before.resolvedBy];
            const who = by ? `${by.name} (${by.kind}, id ${by.id})` : before.resolvedBy;
            return {
              text: `Thread ${before.id} was already resolved${who ? ` by ${who}` : ''} at ${before.resolvedAt}.`,
              board,
            };
          }
          const root = await api.resolveThread(board, args.resolve, true);
          return { text: `Resolved thread ${root.id}.`, board };
        }
        if (args.body === undefined) {
          throw new ToolError(
            'Pass body to comment or reply, or resolve: <thread id> to close a thread. Nothing was posted.',
          );
        }
        const input: CommentInput = { body: args.body };
        if (args.thread !== undefined) input.thread = args.thread;
        else if (args.nodeId !== undefined) input.nodeId = args.nodeId;
        if (args.mentions?.length)
          input.mentions = await resolveMentions(api, board, args.mentions);
        const comment = await api.comment(board, input);
        const where = comment.nodeId !== undefined ? `on node ${comment.nodeId}` : 'on the board';
        const lines = [
          comment.thread === comment.id
            ? `Started thread ${comment.id} ${where}.`
            : `Replied in thread ${comment.thread} ${where} (comment ${comment.id}).`,
        ];
        if (comment.mentions?.length) lines.push(`Mentioned: ${comment.mentions.join(', ')}.`);
        lines.push('People see it on the canvas; replies reach you in board_inbox.');
        return { text: lines.join(' '), board };
      },
      (error) =>
        error.code === 'not_found'
          ? `${sentence(error.message)}. Nothing was posted. Thread ids are in board_inbox; node ids in board_read.`
          : undefined,
    ),
  );

  mcp.registerTool('board_ask', tool('board_ask'), (args, extra) =>
    session.run(
      async (api) => {
        const board = await session.board(api, args.board);
        let ask: Ask;
        let asked = false;
        if (args.askId !== undefined) {
          if (
            args.question !== undefined ||
            args.kind !== undefined ||
            args.options !== undefined ||
            args.nodeIds !== undefined
          ) {
            throw new ToolError(
              'With askId, pass only waitSeconds or cancel: true. To ask something new, leave out askId.',
            );
          }
          if (args.cancel) {
            try {
              const cancelled = await api.cancelAsk(board, args.askId);
              return {
                text: `Withdrew question ${cancelled.id}; people no longer see it. Go on without the answer, or ask again differently.`,
                board,
              };
            } catch (error) {
              if (!(isOpenBoardError(error) && error.code === 'conflict')) throw error;
              ask = await api.askResult(board, args.askId);
              if (ask.status !== 'answered') throw error;
              const nameOf = await namesOn(api, board)();
              return {
                text: `Too late to withdraw: ${formatAsk(ask, { nameOf })}`,
                board,
                covered: (item) => item.askId === ask.id,
              };
            }
          }
          ask = await api.askResult(board, args.askId);
        } else {
          if (args.cancel) {
            throw new ToolError('cancel needs askId: the id of the question to withdraw.');
          }
          if (args.question === undefined) {
            throw new ToolError(
              'Pass question to ask a person, or askId to keep waiting on an earlier question.',
            );
          }
          ask = await api.ask(
            board,
            defined({
              question: args.question,
              kind: args.kind,
              options: args.options,
              nodeIds: args.nodeIds,
            }),
          );
          asked = true;
        }
        const waitSeconds = args.waitSeconds ?? DEFAULT_ASK_WAIT_SECONDS;
        let waitedSeconds = 0;
        if (ask.status === 'open' && waitSeconds > 0) {
          const progressToken = extra._meta?.progressToken;
          const waited = await waitForAnswer(api, board, ask.id, waitSeconds * 1000, {
            signal: extra.signal,
            ...(progressToken !== undefined ? { progressToken } : {}),
            intervalMs: options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
            sendProgress: (progress, total) =>
              extra.sendNotification({
                method: 'notifications/progress',
                params: {
                  progressToken: progressToken as string | number,
                  progress,
                  total,
                  message: 'Waiting for a person to answer on the board',
                },
              }),
          });
          ask = waited.ask;
          waitedSeconds = waited.waitedSeconds;
        }
        const nameOf = ask.status === 'answered' ? await namesOn(api, board)() : (id: string) => id;
        const text = formatAsk(ask, { nameOf, waitedSeconds });
        const answered = ask;
        return {
          text: asked && ask.status === 'open' ? `Asked on the board as ${ask.id}.\n${text}` : text,
          board,
          covered: (item) => item.askId === answered.id,
        };
      },
      (error) =>
        error.code === 'not_found' && /question/.test(error.message)
          ? `${sentence(error.message)}. Question ids come from earlier board_ask results.`
          : undefined,
    ),
  );

  mcp.registerTool('board_undo', tool('board_undo'), (args) =>
    session.run(
      async (api) => {
        const board = await session.board(api, args.board);
        const chosen = [
          args.last === true,
          args.all === true,
          args.batchId !== undefined,
          args.proposalId !== undefined,
        ].filter(Boolean).length;
        if (chosen > 1) {
          throw new ToolError('Pass one of last, all, batchId or proposalId. Nothing was undone.');
        }
        if (args.proposalId !== undefined) {
          const proposal = await api.withdrawProposal(board, args.proposalId);
          return {
            text: `Withdrew proposal ${proposal.id}: none of it will be applied, and it is no longer shown for review.`,
            board,
          };
        }
        const request: UndoRequest =
          args.batchId !== undefined
            ? { batchId: args.batchId }
            : { actorId: api.actor.id, scope: args.all ? 'all' : 'last' };
        const result = await api.undo(board, request);
        const lines = [result.text];
        if (result.undone.length === 0 && result.conflicts.length === 0) {
          lines.push('You have no change of your own left to undo on this board.');
        }
        if (result.conflicts.length > 0) {
          lines.push(
            'Leave those as they are. If they still need to change, ask the user, or change them with board_apply.',
          );
        }
        return { text: lines.join('\n'), board, cursor: result.cursor };
      },
      (error) => {
        const message = sentence(error.message);
        if (error.code === 'forbidden' && /locked/.test(error.message)) {
          return `Refused: ${message}. If something of yours should be taken back, ask the user to do it.`;
        }
        if (error.code === 'forbidden' && /undo/.test(error.message)) {
          return `Refused: ${message}. To revert what someone else did, ask the user (board_ask), or make the change with board_apply.`;
        }
        if (error.code === 'not_found' && /batch/.test(error.message)) {
          return `${message}. Your batch ids are in board_apply results and in board_changes with includeOwn: true.`;
        }
        if (error.code === 'conflict' && /proposal/.test(error.message)) {
          return `${message}, so there is nothing to withdraw. To take back items that were accepted, undo the batch named in its decision in board_inbox.`;
        }
        return undefined;
      },
    ),
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
