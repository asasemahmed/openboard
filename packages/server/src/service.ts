/**
 * `BoardApi` in-process: one session per actor, all sessions sharing the
 * server's live boards. The HTTP routes are a thin layer over this class.
 *
 * "People only" operations check the kind of the calling actor, as declared
 * by the caller (over HTTP, the `x-openboard-actor-kind` header). That is a
 * guard against mistakes, such as an agent accepting its own proposal, not a
 * security boundary: the server has no authentication, and anything that can
 * reach it on loopback can claim to be a person.
 */
import {
  type Actor,
  ActorSchema,
  type AnswerInput,
  AnswerInputSchema,
  type ApplyRequest,
  ApplyRequestSchema,
  type ApplyResult,
  type Ask,
  type AskInput,
  AskInputSchema,
  type AsksOptions,
  AsksOptionsSchema,
  type AsksResult,
  applyOps,
  type Board,
  type BoardApi,
  type BoardEdge,
  type BoardNode,
  type BoardSummary,
  buildProposal,
  type ChangesOptions,
  ChangesOptionsSchema,
  type ChangesResult,
  type Comment,
  type CommentInput,
  CommentInputSchema,
  type CreateBoardInput,
  CreateBoardInputSchema,
  checkItems,
  classifyOps,
  type Decision,
  DecisionSchema,
  explainVerdicts,
  type HistoryOptions,
  HistoryOptionsSchema,
  type HistoryResult,
  IdSchema,
  type InboxOptions,
  InboxOptionsSchema,
  type InboxResult,
  itemFingerprint,
  type LayoutRequest,
  LayoutRequestSchema,
  type LayoutResult,
  MAX_ASK_WAIT_MS,
  MAX_MAX_TOKENS,
  newId,
  type Op,
  type OpError,
  OpenBoardError,
  type Outline,
  type OutlineOptions,
  OutlineOptionsSchema,
  type ProjectConfig,
  type Proposal,
  type ProposalItem,
  type ProposalsResult,
  policyModeFor,
  previewOf,
  proposalOps,
  proposalRefs,
  type ReadQuery,
  ReadQuerySchema,
  type ReadResult,
  type RestoreItems,
  renderAsks,
  renderChanges,
  renderHistory,
  renderInbox,
  renderOutline,
  renderProposals,
  renderRead,
  renderSelection,
  renderUndo,
  rollupStatus,
  type SelectionResult,
  SYSTEM_ACTOR,
  selectItems,
  selectNodes,
  type UndoRequest,
  UndoRequestSchema,
  type UndoResult,
} from '@openboard/core';
import { z } from 'zod';
import type { Boards } from './boards.js';
import { errorMessage } from './fsutil.js';
import type { BatchRecord, Snapshot, TxContext } from './history.js';
import { jsonEqual } from './json.js';
import { type LayoutPatch, layoutFull, layoutIncremental } from './layout/index.js';
import { placePreview, refreshProposal } from './review.js';
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

const ProposalsOptionsSchema = z.object({
  status: z.enum(['pending', 'all']).optional(),
  maxTokens: z.number().int().min(100).max(MAX_MAX_TOKENS).optional(),
});

const AskWaitSchema = z.object({ waitMs: z.number().int().min(0).optional() });

/** Decided proposals kept in the document; older ones are dropped. */
export const DECIDED_PROPOSALS_KEPT = 50;

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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

type Conflict = UndoResult['conflicts'][number];

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

  /** See the note at the top of this file: the kind comes from the caller and is not verified. */
  private requirePerson(what: string): void {
    if (this.actor.kind !== 'human') {
      throw new OpenBoardError(
        'forbidden',
        `${what} is for people only; ask the user to do it on the canvas`,
      );
    }
  }

  private origin(room: Room, source: 'ops' | 'undo' = 'ops') {
    return room.doc.origin(this.actor.id, source);
  }

  // ── Boards and reading ─────────────────────────────────────────────────────

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
    const render: Parameters<typeof renderChanges>[4] = {
      resync,
      actors: { [SYSTEM_ACTOR.id]: SYSTEM_ACTOR, ...room.actors() },
    };
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

  // ── Writing ────────────────────────────────────────────────────────────────

  async apply(boardId: string, request: ApplyRequest): Promise<ApplyResult> {
    const req = parseInput(ApplyEnvelopeSchema, request, 'apply request');
    // Core validates each operation and reports problems by index.
    const ops = req.ops as Op[];
    const room = await this.room(boardId);

    const run = async (): Promise<ApplyResult> => {
      const board = room.doc.toJSON();
      const dry = applyOps(board, ops, { actor: this.actor });
      if (!dry.ok) return { status: 'invalid', cursor: room.cursor, refs: {}, errors: dry.errors };

      const verdicts = classifyOps(board, ops, { actor: this.actor, config: room.config.config });
      const denied = verdicts.filter((v) => v.verdict === 'denied');
      if (denied.length > 0) {
        const errors: OpError[] = denied.map((v) => ({
          index: v.index,
          code: 'forbidden',
          message: `refused by the board's review policy: ${v.why ?? 'agents may not do this here'}`,
        }));
        return { status: 'invalid', cursor: room.cursor, refs: {}, errors };
      }
      const needsReview = verdicts.filter((v) => v.verdict === 'review');
      const review =
        needsReview.length > 0
          ? { indexes: needsReview.map((v) => v.index), why: explainVerdicts(needsReview) }
          : undefined;

      if (req.dryRun) {
        const result: ApplyResult = {
          status: 'valid',
          cursor: room.cursor,
          refs: dry.applied.refs,
          applied: dry.applied,
        };
        if (review) result.review = review;
        return result;
      }

      if (review) {
        const proposal = buildProposal(board, ops, {
          actor: this.actor,
          ...(req.reason ? { reason: req.reason } : {}),
          verdicts,
        });
        const after = applyOps(
          board,
          proposalOps(
            proposal,
            proposal.items.map((i) => i.index),
          ),
          {
            actor: this.actor,
          },
        );
        if (after.ok)
          proposal.preview = await placePreview(after.board, proposal.preview, this.log);
        room.doc.registerActor(this.actor, this.origin(room));
        room.doc.putProposal(proposal, this.origin(room));
        return {
          status: 'proposed',
          cursor: room.cursor,
          refs: proposalRefs(proposal),
          proposalId: proposal.id,
          review,
        };
      }

      const batchId = newId('b');
      const context: TxContext = { batchId };
      if (req.reason) context.reason = req.reason;
      const outcome = room.withContext(context, () => room.doc.apply(ops, { actor: this.actor }));
      if (!outcome.ok) {
        return { status: 'invalid', cursor: room.cursor, refs: {}, errors: outcome.errors };
      }
      if (req.layout !== 'none') await this.placeNew(room, this.actor, batchId);
      const result: ApplyResult = {
        status: 'applied',
        cursor: room.cursor,
        refs: outcome.applied.refs,
        applied: outcome.applied,
      };
      // A batch that changed nothing is not in the history.
      if (room.history.get(batchId)) result.batchId = batchId;
      return result;
    };
    return req.dryRun ? run() : room.lock.run(run);
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
      const moved = await this.writeLayout(room, (b) => layoutFull(b, opts), this.actor, {});
      return { boardId: room.id, cursor: room.cursor, moved };
    });
  }

  /**
   * Give every node without a view a place after a batch, as part of that
   * batch (so undoing it also undoes the placement). Failures are logged, not
   * thrown: the batch already landed.
   */
  private async placeNew(room: Room, actor: Actor, batchId: string): Promise<void> {
    try {
      await this.writeLayout(room, (board) => layoutIncremental(board), actor, {
        mergeInto: batchId,
      });
    } catch (error) {
      this.log(`layout after apply on "${room.id}" failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Compute a layout and write it as `move_node` operations tagged as layout
   * by `actor`. Browsers can edit while the layout engine runs, so a patch
   * that no longer applies is computed once more on the fresh state.
   */
  private async writeLayout(
    room: Room,
    compute: (board: Board) => Promise<LayoutPatch>,
    actor: Actor,
    context: TxContext,
  ): Promise<number> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = room.doc.toJSON();
      const patch = await compute(before);
      const now = room.doc.toJSON();
      const ops = patchToMoves(now, patch);
      if (ops.length === 0) return 0;
      const outcome = room.withContext(context, () =>
        room.doc.apply(ops, { actor, source: 'layout' }),
      );
      if (outcome.ok) return ops.length;
      if (attempt === 1) {
        const first = outcome.errors[0];
        throw new Error(`layout could not be written: ${first?.message ?? 'unknown error'}`);
      }
    }
    return 0;
  }

  // ── Proposals ──────────────────────────────────────────────────────────────

  async proposals(
    boardId: string,
    options?: { status?: 'pending' | 'all'; maxTokens?: number },
  ): Promise<ProposalsResult> {
    const opts = parseInput(ProposalsOptionsSchema, options ?? {}, 'proposals options');
    const room = await this.room(boardId);
    const status = opts.status ?? 'pending';
    const list = room.doc.proposals().filter((p) => status === 'all' || p.status === 'pending');
    return renderProposals(room.id, list, {
      actors: room.actors(),
      status,
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    });
  }

  private proposalOf(room: Room, proposalId: unknown): Proposal {
    const id = parseInput(IdSchema, proposalId, 'proposal id');
    const proposal = room.doc.getProposal(id);
    if (!proposal) {
      throw new OpenBoardError('not_found', `no proposal "${id}" on board "${room.id}"`);
    }
    return proposal;
  }

  async decideProposal(boardId: string, proposalId: string, decision: Decision): Promise<Proposal> {
    this.requirePerson('deciding on a proposal');
    const input = parseInput(DecisionSchema, decision, 'decision');
    const room = await this.room(boardId);
    return room.lock.run(async () => {
      const proposal = this.proposalOf(room, proposalId);
      if (proposal.status !== 'pending') {
        throw new OpenBoardError(
          'conflict',
          `proposal "${proposal.id}" is already ${proposal.status}`,
        );
      }
      const known = new Set(proposal.items.map((item) => item.index));
      const unknown = (input.items ?? []).filter((index) => !known.has(index));
      if (unknown.length > 0) {
        throw new OpenBoardError(
          'invalid_request',
          `proposal "${proposal.id}" has no item ${unknown.join(', ')}; its items are 0-${proposal.items.length - 1}`,
        );
      }
      room.doc.registerActor(this.actor, this.origin(room));
      const { accept, reject } = selectItems(proposal, input);
      const items = new Map(proposal.items.map((item) => [item.index, { ...item }]));
      for (const index of reject) (items.get(index) as ProposalItem).status = 'rejected';

      const author = room.actorFor(proposal.author);
      const accepted: number[] = [];
      const touched = new Set<string>();
      const conflicted: Array<{ index: number; reason: string }> = [];
      if (accept.length > 0) {
        const check = checkItems(room.doc.toJSON(), proposal, accept, { actor: author });
        for (const conflict of check.conflicts) {
          const item = items.get(conflict.index) as ProposalItem;
          item.status = 'conflict';
          item.conflict = conflict.reason;
          conflicted.push(conflict);
        }
        if (check.ok.length > 0) {
          const batchId = newId('b');
          const context: TxContext = { batchId, proposalId: proposal.id };
          if (proposal.reason) context.reason = proposal.reason;
          const outcome = room.withContext(context, () =>
            room.doc.apply(proposalOps(proposal, check.ok), { actor: author }),
          );
          if (outcome.ok) {
            for (const index of check.ok) (items.get(index) as ProposalItem).status = 'accepted';
            accepted.push(...check.ok);
            for (const id of [...outcome.applied.updatedNodes, ...outcome.applied.updatedEdges])
              touched.add(id);
            await this.placeNew(room, author, batchId);
          } else {
            for (const index of check.ok) {
              const item = items.get(index) as ProposalItem;
              item.status = 'conflict';
              item.conflict = outcome.errors[0]?.message ?? 'the board changed while accepting';
              conflicted.push({ index, reason: item.conflict });
            }
          }
        }
      }

      // Items still pending keep tracking their targets; changes this decision
      // made are the proposal's own, not someone else's.
      const board = room.doc.toJSON();
      for (const item of items.values()) {
        if (item.status !== 'pending' || !item.base) continue;
        const base: Record<string, string> = {};
        for (const [id, fingerprint] of Object.entries(item.base)) {
          const current = board.nodes[id] ?? board.edges[id];
          base[id] = current && touched.has(id) ? itemFingerprint(current) : fingerprint;
        }
        item.base = base;
      }

      let next: Proposal = {
        ...proposal,
        items: [...items.values()].sort((a, b) => a.index - b.index),
      };
      next.status = rollupStatus(next.items);
      if (input.note !== undefined) next.note = input.note;
      if (next.status !== 'pending') {
        next.decidedBy = this.actor.id;
        next.decidedAt = new Date().toISOString();
        const empty = previewOf(board, board, {
          refs: {},
          addedNodes: [],
          updatedNodes: [],
          removedNodes: [],
          addedEdges: [],
          updatedEdges: [],
          removedEdges: [],
        });
        next.preview = empty;
      } else {
        next = await refreshProposal(room, board, next, this.log);
      }
      room.doc.putProposal(next, this.origin(room));
      this.pruneProposals(room);
      this.notifyDecision(room, next, { accepted, rejected: reject, conflicted, note: input.note });
      return next;
    });
  }

  async withdrawProposal(boardId: string, proposalId: string): Promise<Proposal> {
    const room = await this.room(boardId);
    return room.lock.run(async () => {
      const proposal = this.proposalOf(room, proposalId);
      if (proposal.author !== this.actor.id) {
        throw new OpenBoardError(
          'forbidden',
          `only its author (${proposal.author}) can withdraw proposal "${proposal.id}"`,
        );
      }
      if (proposal.status !== 'pending') {
        throw new OpenBoardError(
          'conflict',
          `proposal "${proposal.id}" is already ${proposal.status}`,
        );
      }
      const next: Proposal = {
        ...proposal,
        status: 'withdrawn',
        decidedBy: this.actor.id,
        decidedAt: new Date().toISOString(),
      };
      room.doc.putProposal(next, this.origin(room));
      this.pruneProposals(room);
      return next;
    });
  }

  private pruneProposals(room: Room): void {
    const decided = room.doc
      .proposals()
      .filter((p) => p.status !== 'pending')
      .sort((a, b) => ((b.decidedAt ?? b.createdAt) < (a.decidedAt ?? a.createdAt) ? -1 : 1));
    for (const old of decided.slice(DECIDED_PROPOSALS_KEPT)) {
      room.doc.deleteProposal(old.id, room.doc.origin('system', 'ops'));
    }
  }

  private notifyDecision(
    room: Room,
    proposal: Proposal,
    outcome: {
      accepted: number[];
      rejected: number[];
      conflicted: Array<{ index: number; reason: string }>;
      note: string | undefined;
    },
  ): void {
    if (proposal.author === this.actor.id) return;
    const list = (indexes: number[]) => indexes.map((i) => `#${i}`).join(', ');
    const parts: string[] = [];
    if (outcome.accepted.length) parts.push(`accepted ${list(outcome.accepted)}`);
    if (outcome.rejected.length) parts.push(`rejected ${list(outcome.rejected)}`);
    if (outcome.conflicted.length)
      parts.push(`could not apply ${list(outcome.conflicted.map((c) => c.index))}`);
    const pending = proposal.items.filter((item) => item.status === 'pending').length;
    if (pending) parts.push(`${plural(pending, 'item')} still pending`);
    const what = proposal.reason ? ` ${JSON.stringify(proposal.reason)}` : '';
    const bodyLines: string[] = [];
    if (outcome.note) bodyLines.push(outcome.note);
    for (const c of outcome.conflicted)
      bodyLines.push(`#${c.index} could not be applied: ${c.reason}`);
    const item: Parameters<Room['inbox']['deliver']>[1] = {
      kind: 'decision',
      from: this.actor.id,
      summary: `${this.actor.name} decided on your proposal${what} (${proposal.status}): ${parts.join('; ') || 'nothing changed'}`,
      proposalId: proposal.id,
    };
    if (bodyLines.length) item.body = bodyLines.join('\n');
    const batch = [...room.history.all()].reverse().find((r) => r.batch.proposalId === proposal.id);
    if (batch && outcome.accepted.length) item.batchId = batch.batch.id;
    room.inbox.deliver(proposal.author, item);
  }

  // ── History and undo ───────────────────────────────────────────────────────

  async history(boardId: string, options?: HistoryOptions): Promise<HistoryResult> {
    const opts = parseInput(HistoryOptionsSchema, options ?? {}, 'history options');
    const room = await this.room(boardId);
    const { batches, more } = room.history.list(opts);
    return renderHistory(room.id, batches, room.cursor, {
      actors: { [SYSTEM_ACTOR.id]: SYSTEM_ACTOR, ...room.actors() },
      more,
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    });
  }

  async undo(boardId: string, request: UndoRequest): Promise<UndoResult> {
    const req = parseInput(UndoRequestSchema, request, 'undo request');
    const room = await this.room(boardId);
    return room.lock.run(async () => {
      const agent = this.actor.kind === 'agent';
      if (agent && policyModeFor(this.actor, room.config.config) === 'locked') {
        throw new OpenBoardError(
          'forbidden',
          'this agent is locked by the review policy: it may read the board but not change it, undo included',
        );
      }
      let targets: BatchRecord[];
      if ('batchId' in req) {
        const record = room.history.get(req.batchId);
        if (!record) {
          throw new OpenBoardError(
            'not_found',
            `no batch "${req.batchId}" in the history of board "${room.id}"`,
          );
        }
        if (agent && record.batch.actor !== this.actor.id) {
          throw new OpenBoardError(
            'forbidden',
            `batch "${record.batch.id}" was made by ${record.batch.actor}; an agent can only undo its own batches`,
          );
        }
        if (record.batch.undoneBy) {
          throw new OpenBoardError(
            'conflict',
            `batch "${record.batch.id}" was already undone by batch "${record.batch.undoneBy}"; undo that one to redo it`,
          );
        }
        targets = [record];
      } else {
        if (agent && req.actorId !== this.actor.id) {
          throw new OpenBoardError(
            'forbidden',
            `an agent can only undo its own batches, not those of ${req.actorId}`,
          );
        }
        const candidates = [...room.history.all()].reverse().filter(
          (r) =>
            r.batch.actor === req.actorId &&
            !r.batch.undoneBy &&
            r.batch.source !== 'undo' &&
            // Comment-only batches (a reply, resolving a thread) are undone by id only.
            r.batch.nodeIds.length + r.batch.edgeIds.length > 0,
        );
        targets = req.scope === 'last' ? candidates.slice(0, 1) : candidates;
      }

      const undone: string[] = [];
      const conflicts: Conflict[] = [];
      const titles: Record<string, string> = {};
      if (targets.length > 0) room.doc.registerActor(this.actor, this.origin(room));
      for (const record of targets) {
        const result = this.undoOne(room, record, titles);
        conflicts.push(...result.conflicts);
        if (result.undoneBy) undone.push(record.batch.id);
      }
      return {
        boardId: room.id,
        cursor: room.cursor,
        undone,
        conflicts,
        text: renderUndo(
          room.id,
          { cursor: room.cursor, undone, conflicts },
          { titles, batches: targets.map((record) => record.batch) },
        ),
      };
    });
  }

  /** Revert one batch where its changes are still in place. */
  private undoOne(
    room: Room,
    record: BatchRecord,
    titles: Record<string, string>,
  ): { undoneBy: string | null; conflicts: Conflict[] } {
    const doc = room.doc;
    const conflicts: Conflict[] = [];
    const plan: Required<RestoreItems> = { nodes: {}, edges: {}, comments: {} };
    const name = (id: string) => room.actors()[id]?.name ?? id;
    const later = <T extends { updatedBy?: string; updatedAt?: string }>(
      current: T | null,
      snap: Snapshot<T>,
    ): string => {
      if (current === null) return 'removed after this batch';
      if (snap.after === null) return 'added again after this batch';
      if (
        current.updatedAt !== undefined &&
        (current.updatedAt !== snap.after.updatedAt || current.updatedBy !== snap.after.updatedBy)
      ) {
        return `changed by ${name(current.updatedBy ?? '?')} after this batch`;
      }
      return 'moved or edited after this batch';
    };

    for (const [id, snap] of Object.entries(record.nodes)) {
      const current = doc.storedNode(id) ?? null;
      const title = current?.title ?? snap.after?.title ?? snap.before?.title;
      if (title !== undefined) titles[id] = title;
      if (jsonEqual(current, snap.after)) plan.nodes[id] = snap.before;
      else conflicts.push({ kind: 'node', id, reason: later(current, snap) });
    }
    for (const [id, snap] of Object.entries(record.edges)) {
      const current = doc.storedEdge(id) ?? null;
      if (jsonEqual(current, snap.after)) plan.edges[id] = snap.before;
      else conflicts.push({ kind: 'edge', id, reason: later(current, snap) });
    }
    for (const [id, snap] of Object.entries(record.comments)) {
      const current = doc.getComment(id) ?? null;
      if (jsonEqual(current, snap.after)) plan.comments[id] = snap.before;
      else
        conflicts.push({
          kind: 'comment',
          id,
          reason: current ? 'edited after this batch' : 'removed after this batch',
        });
    }

    if (this.actor.kind === 'agent') this.applyUndoPolicy(room, record, plan, conflicts);

    // Never leave dangling references: drop restores that would need what stays as it is.
    const nodePresent = (id: string) =>
      id in plan.nodes ? plan.nodes[id] !== null : doc.storedNode(id) !== undefined;
    const edgePresent = (edge: BoardEdge) =>
      edge.id in plan.edges ? plan.edges[edge.id] !== null : true;
    const storedEdges = doc.toJSON().edges;
    const storedNodes = doc.nodes();
    for (let changed = true; changed; ) {
      changed = false;
      for (const [id, value] of Object.entries(plan.edges)) {
        if (value && (!nodePresent(value.source) || !nodePresent(value.target))) {
          delete plan.edges[id];
          conflicts.push({
            kind: 'edge',
            id,
            reason: 'one of its nodes is not on the board any more',
          });
          changed = true;
        }
      }
      for (const [id, value] of Object.entries(plan.nodes)) {
        if (value === null) {
          const edge = Object.values(storedEdges).find(
            (e) => (e.source === id || e.target === id) && edgePresent(e),
          );
          const child = storedNodes.find((n) => n.parent === id && nodePresent(n.id));
          if (edge || child) {
            delete plan.nodes[id];
            conflicts.push({
              kind: 'node',
              id,
              reason: `${edge ? `edge ${edge.id}` : `node ${(child as BoardNode).id}`}, added or changed later, still points at it`,
            });
            changed = true;
          }
        } else if (value.parent !== undefined && !nodePresent(value.parent)) {
          delete plan.nodes[id];
          conflicts.push({
            kind: 'node',
            id,
            reason: `its frame ${value.parent} is not on the board any more`,
          });
          changed = true;
        }
      }
    }

    const undoId = newId('b');
    room.withContext({ batchId: undoId, undoes: record.batch.id }, () =>
      doc.restore(plan, this.origin(room, 'undo')),
    );
    // Nothing was written when everything conflicted: there is no undo batch.
    if (!room.history.get(undoId)) return { undoneBy: null, conflicts };
    room.history.setUndoneBy(record.batch.id, undoId);
    // Undoing an undo puts the original back in place.
    if (record.batch.undoes) room.history.setUndoneBy(record.batch.undoes, undefined);
    if (record.batch.actor !== this.actor.id && record.batch.actor !== SYSTEM_ACTOR.id) {
      const left = conflicts.length
        ? `; ${plural(conflicts.length, 'item')} left as they were`
        : '';
      room.inbox.deliver(record.batch.actor, {
        kind: 'undone',
        from: this.actor.id,
        summary: `${this.actor.name} undid your change: ${record.batch.summary}${left}`,
        batchId: record.batch.id,
        ...(record.batch.reason ? { body: `Your reason was: ${record.batch.reason}` } : {}),
      });
    }
    return { undoneBy: undoId, conflicts };
  }

  /**
   * An agent restores only what it could change freely right now: each restore
   * is classified as the operation it amounts to, and anything that is not
   * `free` stays as it is. Reviewed items of an accepted proposal are for
   * people to undo. See `UndoRequestSchema` in core.
   */
  private applyUndoPolicy(
    room: Room,
    record: BatchRecord,
    plan: Required<RestoreItems>,
    conflicts: Conflict[],
  ): void {
    const doc = room.doc;
    const board = doc.toJSON();
    const config = room.config.config;
    const reviewed = reviewedIds(doc.getProposal(record.batch.proposalId ?? ''), record);
    const allowed = (kind: 'node' | 'edge', id: string, op: Op): boolean => {
      if (reviewed === 'all' || reviewed.has(id)) {
        conflicts.push({
          kind,
          id,
          reason: 'was applied through a reviewed proposal; ask a person to undo it',
        });
        return false;
      }
      const [verdict] = classifyOps(board, [op], { actor: this.actor, config });
      if (!verdict || verdict.verdict === 'free') return true;
      const label = verdict.verdict === 'denied' ? 'not allowed' : 'needs review';
      conflicts.push({ kind, id, reason: `${label}: ${verdict.rule ?? verdict.why ?? ''}` });
      return false;
    };
    for (const [id, target] of Object.entries(plan.nodes)) {
      const current = doc.storedNode(id);
      let op: Op | null = null;
      if (target === null) {
        if (current) op = { op: 'remove_node', id };
      } else if (!current) {
        const node = { type: target.type, title: target.title };
        op = {
          op: 'add_node',
          id,
          node: target.parent !== undefined ? { ...node, parent: target.parent } : node,
        };
      } else {
        const { view: _a, ...a } = current;
        const { view: _b, ...b } = target;
        if (jsonEqual(a, b)) op = { op: 'move_node', id, view: target.view ?? { x: 0, y: 0 } };
        else {
          const patch: Extract<Op, { op: 'update_node' }>['patch'] = { title: target.title };
          if (current.parent !== target.parent) patch.parent = target.parent ?? null;
          op = { op: 'update_node', id, patch };
        }
      }
      if (op && !allowed('node', id, op)) delete plan.nodes[id];
    }
    for (const [id, target] of Object.entries(plan.edges)) {
      const current = doc.storedEdge(id);
      let op: Op | null = null;
      if (target === null) {
        if (current) op = { op: 'remove_edge', id };
      } else if (!current) {
        op = {
          op: 'add_edge',
          id,
          edge: { type: target.type, source: target.source, target: target.target },
        };
      } else op = { op: 'update_edge', id, patch: { label: target.label ?? null } };
      if (op && !allowed('edge', id, op)) delete plan.edges[id];
    }
  }

  // ── Comments and inbox ─────────────────────────────────────────────────────

  async comment(boardId: string, input: CommentInput): Promise<Comment> {
    const parsed = parseInput(CommentInputSchema, input, 'comment');
    const room = await this.room(boardId);
    const id = newId('c');
    const comment: Comment = {
      id,
      thread: id,
      author: this.actor.id,
      body: parsed.body,
      createdAt: new Date().toISOString(),
    };
    if (parsed.thread !== undefined) {
      const root = room.doc.getComment(parsed.thread);
      if (!root) {
        throw new OpenBoardError(
          'not_found',
          `no comment thread "${parsed.thread}" on board "${room.id}"`,
        );
      }
      comment.thread = root.thread;
      const first = room.doc.getComment(root.thread) ?? root;
      if (first.nodeId !== undefined) comment.nodeId = first.nodeId;
    } else if (parsed.nodeId !== undefined) {
      if (!room.doc.getNode(parsed.nodeId)) {
        throw new OpenBoardError('not_found', `no node "${parsed.nodeId}" on board "${room.id}"`);
      }
      comment.nodeId = parsed.nodeId;
    }
    if (parsed.mentions?.length) comment.mentions = [...new Set(parsed.mentions)];
    room.withContext({}, () =>
      room.doc.putComment(comment, this.origin(room), { actor: this.actor }),
    );
    return comment;
  }

  async resolveThread(boardId: string, thread: string, resolved = true): Promise<Comment> {
    const room = await this.room(boardId);
    if (typeof resolved !== 'boolean') {
      throw new OpenBoardError('invalid_request', '"resolved" must be true or false');
    }
    const found = room.doc.getComment(parseInput(IdSchema, thread, 'thread id'));
    const root = found && (room.doc.getComment(found.thread) ?? found);
    if (!root)
      throw new OpenBoardError('not_found', `no comment thread "${thread}" on board "${room.id}"`);
    const next: Comment = { ...root };
    if (resolved) {
      if (root.resolvedAt) return root;
      next.resolvedAt = new Date().toISOString();
      next.resolvedBy = this.actor.id;
    } else {
      delete next.resolvedAt;
      delete next.resolvedBy;
    }
    room.doc.putComment(next, this.origin(room), { actor: this.actor });
    return room.doc.getComment(root.id) ?? next;
  }

  async inbox(boardId: string, options?: InboxOptions): Promise<InboxResult> {
    const opts = parseInput(InboxOptionsSchema, options ?? {}, 'inbox options');
    const room = await this.room(boardId);
    const items = room.inbox.unread(this.actor.id, opts.since);
    const result = renderInbox(room.id, items, room.inbox.position, {
      actors: { [SYSTEM_ACTOR.id]: SYSTEM_ACTOR, ...room.actors() },
      openAsks: room.doc.asks().filter((a) => a.author === this.actor.id && a.status === 'open')
        .length,
      pendingProposals: room.doc
        .proposals()
        .filter((p) => p.author === this.actor.id && p.status === 'pending').length,
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    });
    if (!opts.peek) room.inbox.markSeen(this.actor.id, result.position);
    return result;
  }

  // ── Questions ──────────────────────────────────────────────────────────────

  private askOf(room: Room, askId: unknown): Ask {
    const id = parseInput(IdSchema, askId, 'question id');
    const ask = room.doc.getAsk(id);
    if (!ask) throw new OpenBoardError('not_found', `no question "${id}" on board "${room.id}"`);
    return ask;
  }

  async ask(boardId: string, input: AskInput): Promise<Ask> {
    const parsed = parseInput(AskInputSchema, input, 'question');
    const room = await this.room(boardId);
    const missing = (parsed.nodeIds ?? []).filter((id) => !room.doc.getNode(id));
    if (missing.length > 0) {
      throw new OpenBoardError(
        'not_found',
        `no node ${missing.map((id) => `"${id}"`).join(', ')} on board "${room.id}"`,
      );
    }
    const ask: Ask = {
      id: newId('a'),
      author: this.actor.id,
      kind: parsed.kind ?? 'question',
      question: parsed.question,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    if (parsed.options?.length) ask.options = parsed.options;
    if (parsed.nodeIds?.length) ask.nodeIds = [...new Set(parsed.nodeIds)];
    room.doc.registerActor(this.actor, this.origin(room));
    room.doc.putAsk(ask, this.origin(room));
    return ask;
  }

  async asks(boardId: string, options?: AsksOptions): Promise<AsksResult> {
    const opts = parseInput(AsksOptionsSchema, options ?? {}, 'questions options');
    const room = await this.room(boardId);
    const status = opts.status ?? 'open';
    const list = room.doc.asks().filter((ask) => status === 'all' || ask.status === 'open');
    return renderAsks(room.id, list, {
      actors: { [SYSTEM_ACTOR.id]: SYSTEM_ACTOR, ...room.actors() },
      status,
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    });
  }

  /**
   * With `waitMs`, waits (at most `MAX_ASK_WAIT_MS`) for the question to be
   * answered or cancelled. `signal` ends the wait early, for example when an
   * HTTP client disconnects.
   */
  async askResult(
    boardId: string,
    askId: string,
    options?: { waitMs?: number; signal?: AbortSignal },
  ): Promise<Ask> {
    const { waitMs } = parseInput(AskWaitSchema, { waitMs: options?.waitMs }, 'wait options');
    const room = await this.room(boardId);
    const ask = this.askOf(room, askId);
    let result = ask;
    if (waitMs && ask.status === 'open') {
      await room.waitForAsk(ask.id, Math.min(waitMs, MAX_ASK_WAIT_MS), options?.signal);
      result = room.doc.getAsk(ask.id) ?? ask;
    }
    // The author now has the answer; its inbox should not deliver it again.
    if (result.status === 'answered' && result.author === this.actor.id) {
      const items = room.inbox.find(
        this.actor.id,
        (item) => item.kind === 'answer' && item.askId === result.id,
      );
      room.inbox.dismiss(
        this.actor.id,
        items.map((item) => item.seq),
      );
    }
    return result;
  }

  async answerAsk(boardId: string, askId: string, answer: AnswerInput): Promise<Ask> {
    this.requirePerson('answering a question');
    const parsed = parseInput(AnswerInputSchema, answer, 'answer');
    const room = await this.room(boardId);
    const ask = this.askOf(room, askId);
    if (ask.status !== 'open') {
      const by = ask.answer ? ` by ${room.actors()[ask.answer.by]?.name ?? ask.answer.by}` : '';
      throw new OpenBoardError('conflict', `question "${ask.id}" is already ${ask.status}${by}`);
    }
    if (parsed.option !== undefined && ask.options && !ask.options.includes(parsed.option)) {
      throw new OpenBoardError(
        'invalid_request',
        `"${parsed.option}" is not one of the options (${ask.options.map((o) => JSON.stringify(o)).join(', ')}); answer in text instead`,
      );
    }
    room.doc.registerActor(this.actor, this.origin(room));
    const next: Ask = {
      ...ask,
      status: 'answered',
      answer: {
        by: this.actor.id,
        at: new Date().toISOString(),
        ...(parsed.option !== undefined ? { option: parsed.option } : {}),
        ...(parsed.text !== undefined ? { text: parsed.text } : {}),
      },
    };
    room.doc.putAsk(next, this.origin(room));
    return next;
  }

  async cancelAsk(boardId: string, askId: string): Promise<Ask> {
    const room = await this.room(boardId);
    const ask = this.askOf(room, askId);
    if (ask.author !== this.actor.id && this.actor.kind !== 'human') {
      throw new OpenBoardError(
        'forbidden',
        `only its author (${ask.author}) or a person can cancel question "${ask.id}"`,
      );
    }
    if (ask.status !== 'open') {
      throw new OpenBoardError('conflict', `question "${ask.id}" is already ${ask.status}`);
    }
    const next: Ask = { ...ask, status: 'cancelled' };
    room.doc.putAsk(next, this.origin(room));
    return next;
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async getConfig(): Promise<ProjectConfig> {
    return this.boards.config.config;
  }

  async setConfig(config: ProjectConfig): Promise<ProjectConfig> {
    this.requirePerson('changing the project settings');
    return this.boards.config.set(config);
  }
}

/**
 * Ids in `record` that a person approved as reviewed items of `proposal`
 * (with what their removals took along), or `all` when the batch came from a
 * proposal that is no longer kept.
 */
function reviewedIds(proposal: Proposal | undefined, record: BatchRecord): Set<string> | 'all' {
  if (!record.batch.proposalId) return new Set();
  if (!proposal) return 'all';
  const ids = new Set<string>();
  const removed: string[] = [];
  for (const item of proposal.items) {
    if (!item.needsReview || item.status !== 'accepted') continue;
    const op = item.op;
    if (op.id !== undefined) ids.add(op.id);
    if (op.op === 'remove_node') removed.push(op.id);
  }
  for (const [id, snap] of Object.entries(record.edges)) {
    const edge = snap.before;
    if (edge && (removed.includes(edge.source) || removed.includes(edge.target))) ids.add(id);
  }
  for (const [id, snap] of Object.entries(record.nodes)) {
    const parent = snap.before?.parent;
    if (parent !== undefined && removed.includes(parent) && !snap.after?.parent) ids.add(id);
  }
  return ids;
}
