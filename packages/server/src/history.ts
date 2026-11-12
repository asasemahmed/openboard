/**
 * The history of one board: every change to nodes, edges and comments as a
 * `Batch`, with the exact state of each item it touched before and after, so
 * the batch can be undone precisely.
 *
 * Stored in `.local/<id>.history.jsonl`, one record per line. A record is
 * written again whenever its batch grows (coalesced browser edits, the layout
 * pass that follows an apply) or is marked undone; the last line for a batch
 * id wins. The file is compacted when it is opened.
 *
 * Next to batches it keeps one step per transaction that changed the board
 * JSON (`{"step": ...}` lines), with exact before and after states, which is
 * what `snapshotAt` replays backwards. A batch can merge several
 * transactions, so it cannot serve that purpose itself.
 *
 * The first line names the document lineage the history belongs to; a file
 * written for another lineage (the document was rebuilt from the board file)
 * is discarded, since its states no longer chain to the live document.
 */
import { appendFile, readFile } from 'node:fs/promises';
import {
  type Batch,
  type Board,
  BoardDoc,
  type BoardEdge,
  type BoardNode,
  type Comment,
  type DocEvent,
  type DocStates,
  type HistoryOptions,
  newId,
  OpenBoardError,
} from '@openboard/core';
import { errorMessage, isErrno, writeFileAtomic } from './fsutil.js';
import { jsonEqual } from './json.js';

/** How many batches are kept. */
export const HISTORY_RETAIN = 2000;
/** Browser edits by one person less than this far apart are one batch. */
export const UI_COALESCE_MS = 5000;
/** How many transactions are kept for `snapshotAt`. */
export const STEPS_RETAIN = 5000;

/** One transaction that changed the board JSON. */
export interface Step {
  seq: number;
  /** The cursor before and after it; equal when it moved no change into the feed. */
  from: number;
  cursor: number;
  states: DocStates;
}

export interface Snapshot<T> {
  before: T | null;
  after: T | null;
}

export interface BatchRecord {
  batch: Batch;
  nodes: Record<string, Snapshot<BoardNode>>;
  edges: Record<string, Snapshot<BoardEdge>>;
  comments: Record<string, Snapshot<Comment>>;
  /** When the last transaction was merged in, in ms since the epoch. */
  last: number;
}

/** What the server says about a transaction it is about to make. */
export interface TxContext {
  /** Use this id for the batch the transaction creates. */
  batchId?: string;
  /** Add the transaction to this existing batch instead (the layout pass after an apply). */
  mergeInto?: string;
  reason?: string;
  proposalId?: string;
  undoes?: string;
}

/** The batch a transaction will be recorded in, decided before the change feed records it. */
export interface PendingBatch {
  id: string;
  record: BatchRecord | null;
  actor: string;
  source: Batch['source'];
  reason?: string;
}

export class History {
  private records: BatchRecord[] = [];
  private readonly byId = new Map<string, BatchRecord>();
  private steps: Step[] = [];
  private stepSeq = 0;
  private lineage = '';
  private writes: Promise<void> = Promise.resolve();
  private linesOnDisk = 0;

  private constructor(
    private readonly file: string,
    private readonly retain: number,
    private readonly log: (line: string) => void,
  ) {}

  static async open(
    file: string,
    opts: { retain?: number; log?: (line: string) => void; lineage?: string } = {},
  ): Promise<History> {
    const history = new History(file, opts.retain ?? HISTORY_RETAIN, opts.log ?? (() => {}));
    history.lineage = opts.lineage ?? '';
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    let lines = text.split('\n').filter((line) => line.trim() !== '');
    const header = lines[0] === undefined ? undefined : parseLineage(lines[0]);
    if (opts.lineage !== undefined && header !== opts.lineage) {
      // Written for another document (or before lineages existed): start over.
      if (lines.length > 0)
        history.log(`history ${file} belongs to another document; starting a new one`);
      lines = [];
    }
    for (const line of lines) {
      const step = parseStep(line);
      if (step) {
        history.steps.push(step);
        history.stepSeq = Math.max(history.stepSeq, step.seq);
        continue;
      }
      const record = parseRecord(line);
      if (!record) continue; // a torn last line, or a hand edit
      const existing = history.byId.get(record.batch.id);
      if (existing) history.records[history.records.indexOf(existing)] = record;
      else history.records.push(record);
      history.byId.set(record.batch.id, record);
    }
    history.trim();
    if (lines.length === 0 || lines.length > history.records.length + history.steps.length + 1) {
      await history.compact();
    } else history.linesOnDisk = lines.length;
    return history;
  }

  /** Record one transaction for replay. Called for every event that has `states`. */
  step(states: DocStates, from: number, cursor: number): void {
    const step: Step = { seq: ++this.stepSeq, from, cursor, states };
    this.steps.push(step);
    if (this.steps.length > STEPS_RETAIN) this.steps.splice(0, this.steps.length - STEPS_RETAIN);
    this.append(`${JSON.stringify({ step })}\n`);
  }

  /** The oldest cursor `snapshot` can rebuild: the cursor before the oldest kept step. */
  earliest(current: number): number {
    return this.steps[0]?.from ?? current;
  }

  /**
   * The board right after `cursor`, from `raw` (the live document's `raw()`)
   * by undoing every later step. Throws `not_found` when `cursor` is older
   * than `earliest`, `invalid_request` when it is in the future.
   */
  snapshot(raw: Board, cursor: number, current: number): Board {
    const earliest = this.earliest(current);
    if (cursor > current) {
      throw new OpenBoardError(
        'invalid_request',
        `cursor ${cursor} is ahead of the board (cursor now ${current})`,
      );
    }
    if (cursor < earliest) {
      throw new OpenBoardError(
        'not_found',
        `history does not reach back to cursor ${cursor}; the earliest cursor available is ${earliest}`,
        { earliest },
      );
    }
    // The last transaction that moved the cursor to (or past, within it) `cursor`.
    let target = 0;
    for (const step of this.steps)
      if (step.cursor > step.from && step.cursor <= cursor) target = step.seq;
    const board: Board = structuredClone(raw);
    const comments: Record<string, Comment> = { ...(board.comments ?? {}) };
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const step = this.steps[i] as Step;
      if (step.seq <= target) break;
      revert(board.nodes, step.states.nodes);
      revert(board.edges, step.states.edges);
      revert(comments, step.states.comments);
      revert(board.actors, step.states.actors ?? {});
      if (step.states.meta) {
        const before = step.states.meta.before;
        board.id = before.id;
        board.name = before.name;
        board.createdAt = before.createdAt;
        board.updatedAt = before.updatedAt;
        if (before.description === undefined) delete board.description;
        else board.description = before.description;
      }
    }
    if (Object.keys(comments).length > 0) board.comments = comments;
    else delete board.comments;
    // Apply the same repairs the live document applies when reading.
    const doc = BoardDoc.fromJSON(board);
    const out = doc.toJSON();
    doc.destroy();
    return out;
  }

  get(id: string): BatchRecord | undefined {
    return this.byId.get(id);
  }

  /** Every retained record, oldest first. */
  all(): readonly BatchRecord[] {
    return this.records;
  }

  /**
   * Decide which batch a transaction belongs to. Returns null when it changed
   * no node, edge or comment.
   */
  begin(event: DocEvent, ctx: TxContext | null, now = Date.now()): PendingBatch | null {
    const states = event.states;
    // Code-link upkeep by the server is not something anyone did, so not a batch.
    if (event.origin?.source === 'code') return null;
    if (
      !states ||
      Object.keys(states.nodes).length +
        Object.keys(states.edges).length +
        Object.keys(states.comments).length ===
        0
    ) {
      return null;
    }
    const actor = event.origin?.actorId ?? 'system';
    const raw = event.origin?.source ?? 'sync';
    // Browser edits arrive over sync; they are what the person did in the UI.
    const source: Batch['source'] = event.origin && (raw === 'sync' || raw === 'ui') ? 'ui' : raw;
    if (ctx?.mergeInto) {
      const record = this.byId.get(ctx.mergeInto);
      if (record) return { id: record.batch.id, record, actor, source };
    }
    if (source === 'ui') {
      const newest = this.records[this.records.length - 1];
      if (
        newest &&
        newest.batch.source === 'ui' &&
        newest.batch.actor === actor &&
        !newest.batch.undoneBy &&
        now - newest.last < UI_COALESCE_MS
      ) {
        return { id: newest.batch.id, record: newest, actor, source };
      }
    }
    const pending: PendingBatch = { id: ctx?.batchId ?? newId('b'), record: null, actor, source };
    if (ctx?.reason) pending.reason = ctx.reason;
    return pending;
  }

  /** Record a transaction in the batch `begin` chose. */
  commit(
    pending: PendingBatch,
    event: DocEvent,
    ctx: TxContext | null,
    cursor: number,
    now = Date.now(),
  ): BatchRecord {
    const states = event.states ?? { nodes: {}, edges: {}, comments: {} };
    let record = pending.record;
    if (!record) {
      const batch: Batch = {
        id: pending.id,
        cursor,
        at: new Date(now).toISOString(),
        actor: pending.actor,
        source: pending.source,
        summary: '',
        nodeIds: [],
        edgeIds: [],
      };
      if (ctx?.reason) batch.reason = ctx.reason;
      if (ctx?.proposalId) batch.proposalId = ctx.proposalId;
      if (ctx?.undoes) batch.undoes = ctx.undoes;
      record = { batch, nodes: {}, edges: {}, comments: {}, last: now };
      this.records.push(record);
      this.byId.set(batch.id, record);
      this.trim();
    }
    merge(record.nodes, states.nodes);
    merge(record.edges, states.edges);
    merge(record.comments, states.comments);
    record.last = now;
    record.batch.cursor = cursor;
    describeBatch(record);
    this.persist(record);
    return record;
  }

  /** Set or clear a batch's `undoneBy`. */
  setUndoneBy(id: string, undoneBy: string | undefined): void {
    const record = this.byId.get(id);
    if (!record) return;
    if (undoneBy === undefined) delete record.batch.undoneBy;
    else record.batch.undoneBy = undoneBy;
    this.persist(record);
  }

  /** Batches matching `options`, newest first, and whether older ones exist beyond `limit`. */
  list(options: HistoryOptions): { batches: Batch[]; more: boolean } {
    const limit = options.limit ?? 20;
    const out: Batch[] = [];
    let more = false;
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i] as BatchRecord;
      const batch = record.batch;
      if (options.before !== undefined && batch.cursor >= options.before) continue;
      if (options.actor !== undefined && batch.actor !== options.actor) continue;
      if (!options.includeMoves && isMovesOnly(record)) continue;
      if (out.length === limit) {
        more = true;
        break;
      }
      out.push(structuredClone(batch));
    }
    return { batches: out, more };
  }

  /** Resolves once every record is on disk. */
  flush(): Promise<void> {
    return this.writes;
  }

  private trim(): void {
    if (this.records.length <= this.retain) return;
    for (const dropped of this.records.splice(0, this.records.length - this.retain)) {
      this.byId.delete(dropped.batch.id);
    }
  }

  private snapshotText(): { text: string; lines: number } {
    const lines = [
      JSON.stringify({ lineage: this.lineage }),
      ...this.records.map((record) => JSON.stringify(record)),
      ...this.steps.map((step) => JSON.stringify({ step })),
    ];
    return { text: `${lines.join('\n')}\n`, lines: lines.length };
  }

  private compact(): Promise<void> {
    const { text, lines } = this.snapshotText();
    this.writes = this.writes.then(async () => {
      try {
        await writeFileAtomic(this.file, text);
        this.linesOnDisk = lines;
      } catch (error) {
        this.log(`history: could not write ${this.file}: ${errorMessage(error)}`);
      }
    });
    return this.writes;
  }

  private persist(record: BatchRecord): void {
    this.append(`${JSON.stringify(record)}\n`);
  }

  private append(line: string): void {
    this.writes = this.writes.then(async () => {
      try {
        if (this.linesOnDisk + 1 > (this.retain + STEPS_RETAIN) * 2) {
          const { text, lines } = this.snapshotText();
          await writeFileAtomic(this.file, text);
          this.linesOnDisk = lines;
        } else {
          await appendFile(this.file, line);
          this.linesOnDisk++;
        }
      } catch (error) {
        this.log(`history: could not write ${this.file}: ${errorMessage(error)}`);
      }
    });
  }
}

function revert<T>(into: Record<string, T>, states: Record<string, Snapshot<T>>): void {
  for (const [id, state] of Object.entries(states)) {
    if (state.before === null) delete into[id];
    else into[id] = state.before;
  }
}

function parseLineage(line: string): string | undefined {
  try {
    const raw = JSON.parse(line) as { lineage?: unknown };
    return typeof raw.lineage === 'string' ? raw.lineage : undefined;
  } catch {
    return undefined;
  }
}

function parseStep(line: string): Step | null {
  try {
    const raw = JSON.parse(line) as { step?: Partial<Step> };
    const step = raw.step;
    if (
      !step ||
      typeof step.seq !== 'number' ||
      typeof step.from !== 'number' ||
      typeof step.cursor !== 'number' ||
      !isRecordOf(step.states)
    ) {
      return null;
    }
    return step as Step;
  } catch {
    return null;
  }
}

function merge<T>(into: Record<string, Snapshot<T>>, states: Record<string, Snapshot<T>>): void {
  for (const [id, state] of Object.entries(states)) {
    const existing = into[id];
    if (existing) existing.after = state.after;
    else into[id] = { before: state.before, after: state.after };
    const item = into[id] as Snapshot<T>;
    // Changed and changed back within one batch: nothing to undo.
    if (jsonEqual(item.before, item.after)) delete into[id];
  }
}

function onlyViewChanged(state: Snapshot<BoardNode>): boolean {
  if (!state.before || !state.after) return false;
  const { view: _a, ...a } = state.before;
  const { view: _b, ...b } = state.after;
  return jsonEqual(a, b);
}

/** A layout run, or a batch that only moved nodes. */
export function isMovesOnly(record: BatchRecord): boolean {
  if (record.batch.source === 'layout') return true;
  const nodes = Object.values(record.nodes);
  return (
    nodes.length > 0 &&
    Object.keys(record.edges).length === 0 &&
    Object.keys(record.comments).length === 0 &&
    nodes.every(onlyViewChanged)
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Refresh the batch's ids and summary from its snapshots. */
function describeBatch(record: BatchRecord): void {
  const counts = {
    added: { node: 0, edge: 0, comment: 0 },
    updated: { node: 0, edge: 0, comment: 0 },
    moved: { node: 0, edge: 0, comment: 0 },
    removed: { node: 0, edge: 0, comment: 0 },
  };
  const tally = <T>(states: Record<string, Snapshot<T>>, kind: 'node' | 'edge' | 'comment') => {
    for (const state of Object.values(states)) {
      if (!state.before) counts.added[kind]++;
      else if (!state.after) counts.removed[kind]++;
      else if (kind === 'node' && onlyViewChanged(state as Snapshot<BoardNode>))
        counts.moved[kind]++;
      else counts.updated[kind]++;
    }
  };
  tally(record.nodes, 'node');
  tally(record.edges, 'edge');
  tally(record.comments, 'comment');
  const groups: string[] = [];
  for (const [verb, group] of Object.entries(counts)) {
    const parts = (['node', 'edge', 'comment'] as const)
      .filter((kind) => group[kind] > 0)
      .map((kind) => plural(group[kind], kind));
    if (parts.length) groups.push(`${verb} ${list(parts)}`);
  }
  const text = groups.join('; ') || 'no net change';
  record.batch.summary = text.charAt(0).toUpperCase() + text.slice(1);
  record.batch.nodeIds = Object.keys(record.nodes).sort();
  record.batch.edgeIds = Object.keys(record.edges).sort();
  const comments = Object.keys(record.comments).sort();
  if (comments.length) record.batch.commentIds = comments;
  else delete record.batch.commentIds;
}

function isRecordOf(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(line: string): BatchRecord | null {
  try {
    const raw = JSON.parse(line) as Partial<BatchRecord>;
    const batch = raw.batch;
    if (
      !isRecordOf(batch) ||
      typeof batch.id !== 'string' ||
      typeof batch.cursor !== 'number' ||
      typeof batch.actor !== 'string' ||
      typeof batch.source !== 'string' ||
      !isRecordOf(raw.nodes) ||
      !isRecordOf(raw.edges)
    ) {
      return null;
    }
    return {
      batch: batch as Batch,
      nodes: raw.nodes as BatchRecord['nodes'],
      edges: raw.edges as BatchRecord['edges'],
      comments: (isRecordOf(raw.comments) ? raw.comments : {}) as BatchRecord['comments'],
      last: typeof raw.last === 'number' ? raw.last : 0,
    };
  } catch {
    return null;
  }
}
