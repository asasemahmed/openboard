/**
 * `BoardApi` in-process: one session per actor, all sessions sharing the
 * server's live boards. The HTTP routes are a thin layer over this class.
 */
import {
  type Actor,
  ActorSchema,
  type ApplyRequest,
  ApplyRequestSchema,
  type ApplyResult,
  applyOps,
  type Board,
  type BoardApi,
  type BoardSummary,
  type ChangesOptions,
  ChangesOptionsSchema,
  type ChangesResult,
  type CreateBoardInput,
  CreateBoardInputSchema,
  type LayoutRequest,
  LayoutRequestSchema,
  type LayoutResult,
  type Op,
  OpenBoardError,
  type Outline,
  type OutlineOptions,
  OutlineOptionsSchema,
  type ReadQuery,
  ReadQuerySchema,
  type ReadResult,
  renderChanges,
  renderOutline,
  renderRead,
  renderSelection,
  type SelectionResult,
  selectNodes,
} from '@openboard/core';
import { z } from 'zod';
import type { Boards } from './boards.js';
import { errorMessage } from './fsutil.js';
import { type LayoutPatch, layoutFull, layoutIncremental } from './layout/index.js';
import type { Room } from './room.js';

/** Parse `input` with `schema`, turning failure into an `invalid_request` with every issue listed. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  const summary = issues
    .slice(0, 3)
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join('; ');
  throw new OpenBoardError('invalid_request', `invalid ${what}: ${summary}`, issues);
}

/**
 * The apply envelope. Operations are only checked for being a non-empty list
 * here: core validates each one itself and reports problems by index, with
 * better messages (unknown fields, hints) than a schema failure would give.
 */
const ApplyEnvelopeSchema = ApplyRequestSchema.extend({ ops: z.array(z.unknown()).min(1) });

/**
 * Turn a layout patch into `move_node` operations. Layout never pins a node,
 * so `pinned` is left out (the merge keeps whatever the node had), except when
 * the layout cleared it (`scope: 'all'`): `move_node` merges views and cannot
 * delete a key, so the pin is cleared with an explicit `false`.
 */
export function patchToMoves(board: Board, patch: LayoutPatch): Op[] {
  const ops: Op[] = [];
  for (const [id, view] of patch) {
    const node = board.nodes[id];
    if (!node) continue;
    const { pinned, ...rest } = view;
    const next: typeof view = { ...rest };
    if (node.view?.pinned === true && pinned !== true) next.pinned = false;
    ops.push({ op: 'move_node', id, view: next });
  }
  return ops;
}

export class LocalBoardApi implements BoardApi {
  readonly actor: Actor;

  constructor(
    private readonly boards: Boards,
    actor: Actor,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.actor = parseInput(ActorSchema, actor, 'actor');
  }

  private async room(boardId: unknown): Promise<Room> {
    if (typeof boardId !== 'string') {
      throw new OpenBoardError('invalid_request', 'board id must be a string');
    }
    const room = await this.boards.get(boardId);
    room.knownActors.set(this.actor.id, this.actor);
    return room;
  }

  async listBoards(): Promise<BoardSummary[]> {
    return this.boards.list();
  }

  async createBoard(input: CreateBoardInput): Promise<BoardSummary> {
    const parsed = parseInput(CreateBoardInputSchema, input, 'board');
    const room = await this.boards.create(parsed, this.actor);
    return room.doc.summary();
  }

  async getBoard(boardId: string): Promise<Board> {
    return (await this.room(boardId)).doc.toJSON();
  }

  async outline(boardId: string, options?: OutlineOptions): Promise<Outline> {
    const opts = parseInput(OutlineOptionsSchema, options ?? {}, 'outline options');
    const room = await this.room(boardId);
    return renderOutline(room.doc.toJSON(), room.cursor, opts);
  }

  async read(boardId: string, query?: ReadQuery): Promise<ReadResult> {
    const q = parseInput(ReadQuerySchema, query ?? {}, 'read query');
    const room = await this.room(boardId);
    const board = room.doc.toJSON();
    const selection = q.selection ? room.humanSelection() : null;
    const nodes = selectNodes(board, q, { selection: { nodeIds: selection?.nodeIds ?? [] } });
    const opts: { detail?: ReadQuery['detail']; maxTokens?: number } = {};
    if (q.detail !== undefined) opts.detail = q.detail;
    if (q.maxTokens !== undefined) opts.maxTokens = q.maxTokens;
    return renderRead(board, nodes, room.cursor, opts);
  }

  async changes(boardId: string, options: ChangesOptions): Promise<ChangesResult> {
    const opts = parseInput(ChangesOptionsSchema, options, 'changes options');
    const room = await this.room(boardId);
    const cursor = room.cursor;
    const { entries, resync } = room.feed.since(opts.since);
    const visible = entries.filter(
      (entry) =>
        (opts.includeOwn || entry.actor !== this.actor.id) &&
        (opts.includeMoves || entry.kind !== 'node_moved'),
    );
    const render: Parameters<typeof renderChanges>[4] = { resync, actors: room.actors() };
    if (opts.maxTokens !== undefined) render.maxTokens = opts.maxTokens;
    return renderChanges(room.id, visible, opts.since, cursor, render);
  }

  async selection(boardId: string): Promise<SelectionResult> {
    const room = await this.room(boardId);
    const selection = room.humanSelection();
    return renderSelection(
      room.doc.toJSON(),
      {
        by: selection?.by ?? null,
        nodeIds: selection?.nodeIds ?? [],
        edgeIds: selection?.edgeIds ?? [],
      },
      room.cursor,
    );
  }

  async apply(boardId: string, request: ApplyRequest): Promise<ApplyResult> {
    const req = parseInput(ApplyEnvelopeSchema, request, 'apply request');
    // Core validates each operation and reports problems by index.
    const ops = req.ops as Op[];
    const room = await this.room(boardId);

    if (req.dryRun) {
      const outcome = applyOps(room.doc.toJSON(), ops, { actor: this.actor });
      if (!outcome.ok)
        return { status: 'invalid', cursor: room.cursor, refs: {}, errors: outcome.errors };
      return {
        status: 'valid',
        cursor: room.cursor,
        refs: outcome.applied.refs,
        applied: outcome.applied,
      };
    }

    return room.lock.run(async () => {
      const outcome = room.doc.apply(ops, { actor: this.actor });
      if (!outcome.ok) {
        return { status: 'invalid', cursor: room.cursor, refs: {}, errors: outcome.errors };
      }
      if (req.layout !== 'none') await this.placeNew(room);
      return {
        status: 'applied',
        cursor: room.cursor,
        refs: outcome.applied.refs,
        applied: outcome.applied,
      };
    });
  }

  async layout(boardId: string, request?: LayoutRequest): Promise<LayoutResult> {
    const req = parseInput(LayoutRequestSchema, request ?? {}, 'layout request');
    const room = await this.room(boardId);
    return room.lock.run(async () => {
      const board = room.doc.toJSON();
      const scope = req.scope ?? 'unpinned';
      if (scope !== 'unpinned' && scope !== 'all' && board.nodes[scope]?.type !== 'frame') {
        throw new OpenBoardError(
          'invalid_request',
          `layout scope "${scope}" is not a frame on board "${room.id}"`,
        );
      }
      const opts: Parameters<typeof layoutFull>[1] = { scope };
      if (req.direction) opts.direction = req.direction;
      const moved = await this.writeLayout(room, (b) => layoutFull(b, opts));
      return { boardId: room.id, cursor: room.cursor, moved };
    });
  }

  /** Give every node without a view a place, after an apply. Failures are logged, not thrown: the apply already landed. */
  private async placeNew(room: Room): Promise<void> {
    try {
      await this.writeLayout(room, (board) => layoutIncremental(board));
    } catch (error) {
      this.log(`layout after apply on "${room.id}" failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Compute a layout and write it as `move_node` operations tagged as layout
   * by this actor. Browsers can edit while the layout engine runs, so a patch
   * that no longer applies is computed once more on the fresh state.
   */
  private async writeLayout(
    room: Room,
    compute: (board: Board) => Promise<LayoutPatch>,
  ): Promise<number> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = room.doc.toJSON();
      const patch = await compute(before);
      const now = room.doc.toJSON();
      const ops = patchToMoves(now, patch);
      if (ops.length === 0) return 0;
      const outcome = room.doc.apply(ops, { actor: this.actor, source: 'layout' });
      if (outcome.ok) return ops.length;
      if (attempt === 1) {
        const first = outcome.errors[0];
        throw new Error(`layout could not be written: ${first?.message ?? 'unknown error'}`);
      }
    }
    return 0;
  }
}
