/**
 * The history of one board: every change to nodes, edges and comments as a
 * `Batch`, with the exact state of each item it touched before and after, so
 * the batch can be undone precisely.
 *
 * Stored in `.local/<id>.history.jsonl`, one record per line. A record is
 * written again whenever its batch grows (coalesced browser edits, the layout
 * pass that follows an apply) or is marked undone; the last line for a batch
 * id wins. The file is compacted when it is opened.
 */
import { appendFile, readFile } from 'node:fs/promises';
import {
  type Batch,
  type BoardEdge,
  type BoardNode,
  type Comment,
  type DocEvent,
  type HistoryOptions,
  newId,
} from '@openboard/core';
import { errorMessage, isErrno, writeFileAtomic } from './fsutil.js';
import { jsonEqual } from './json.js';

/** How many batches are kept. */
export const HISTORY_RETAIN = 2000;
/** Browser edits by one person less than this far apart are one batch. */
export const UI_COALESCE_MS = 5000;

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
  private writes: Promise<void> = Promise.resolve();
  private linesOnDisk = 0;

  private constructor(
    private readonly file: string,
    private readonly retain: number,
    private readonly log: (line: string) => void,
  ) {}

  static async open(
    file: string,
    opts: { retain?: number; log?: (line: string) => void } = {},
  ): Promise<History> {
    const history = new History(file, opts.retain ?? HISTORY_RETAIN, opts.log ?? (() => {}));
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    for (const line of lines) {
      const record = parseRecord(line);
      if (!record) continue; // a torn last line, or a hand edit
      const existing = history.byId.get(record.batch.id);
      if (existing) history.records[history.records.indexOf(existing)] = record;
      else history.records.push(record);
      history.byId.set(record.batch.id, record);
    }
    history.trim();
    if (lines.length > history.records.length) await history.compact();
    else history.linesOnDisk = lines.length;
    return history;
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
    if (!states) return null;
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

  private compact(): Promise<void> {
    const text = this.records.map((record) => `${JSON.stringify(record)}\n`).join('');
    this.writes = this.writes.then(async () => {
      try {
        await writeFileAtomic(this.file, text);
        this.linesOnDisk = this.records.length;
      } catch (error) {
        this.log(`history: could not write ${this.file}: ${errorMessage(error)}`);
      }
    });
    return this.writes;
  }

  private persist(record: BatchRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    this.writes = this.writes.then(async () => {
      try {
        if (this.linesOnDisk + 1 > this.retain * 2) {
          const text = this.records.map((r) => `${JSON.stringify(r)}\n`).join('');
          await writeFileAtomic(this.file, text);
          this.linesOnDisk = this.records.length;
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
