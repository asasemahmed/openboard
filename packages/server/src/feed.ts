/**
 * The change feed of one board: every node and edge change, numbered with a
 * strictly increasing `seq` (the board's cursor) and attributed to an actor.
 *
 * Entries are appended to `.local/<id>.changes.jsonl` so the cursor survives a
 * restart, and the newest few thousand are kept in memory to answer
 * `changes(since)`. When a caller asks for history older than what is kept, or
 * for a cursor this feed never reached (its runtime state was wiped), the
 * answer says `resync` so the caller re-reads instead of trusting a gap.
 *
 * Comments are part of the board but have no change kind of their own: a
 * transaction that only changed comments still moves the cursor, through a
 * mark line (`{"seq", "mark"}`) that is never returned by `since`.
 */
import { appendFile, readFile } from 'node:fs/promises';
import type { BoardDoc, ChangeEntry, DocEvent } from '@openboard/core';
import { ChangeKindSchema } from '@openboard/core';
import { errorMessage, isErrno, writeFileAtomic } from './fsutil.js';

/** How many entries are kept in memory (and, after compaction, on disk). */
export const FEED_RETAIN = 5000;

/** What the server knows about a transaction beyond its origin. */
export interface FeedTag {
  reason?: string;
  batchId?: string;
}

export interface FeedOptions {
  retain?: number;
  log?: (line: string) => void;
}

export class ChangeFeed {
  private entries: ChangeEntry[] = [];
  private seq = 0;
  private linesOnDisk = 0;
  private writes: Promise<void> = Promise.resolve();
  private readonly retain: number;
  private readonly log: (line: string) => void;

  private constructor(
    private readonly file: string,
    opts: FeedOptions,
  ) {
    this.retain = opts.retain ?? FEED_RETAIN;
    this.log = opts.log ?? (() => {});
  }

  /** Open the feed stored in `file`, restoring the cursor and the retained entries. */
  static async open(file: string, opts: FeedOptions = {}): Promise<ChangeFeed> {
    const feed = new ChangeFeed(file, opts);
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    const restored: ChangeEntry[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      feed.linesOnDisk++;
      const mark = parseMark(line);
      if (mark !== null) {
        feed.seq = Math.max(feed.seq, mark);
        continue;
      }
      const entry = parseEntry(line);
      // A torn last line (crash mid-append) or a hand-edited one is skipped.
      if (entry && entry.seq > feed.seq) {
        restored.push(entry);
        feed.seq = entry.seq;
      }
    }
    feed.entries = restored.slice(-feed.retain);
    return feed;
  }

  /** The current cursor: the `seq` of the newest entry, 0 for a new feed. */
  get cursor(): number {
    return this.seq;
  }

  /**
   * Record every change `doc` reports from now on. A transaction is attributed
   * to its origin's actor; one without a `TxOrigin` (nothing the server makes)
   * is attributed to `system`.
   */
  attach(doc: BoardDoc): () => void {
    return doc.observe((event) => this.record(event));
  }

  /** Record one transaction. Called by `attach`, or by a room that tags its transactions. */
  record(event: DocEvent, tag: FeedTag = {}): void {
    if (event.changes.length === 0) {
      if (event.comments && event.comments.length > 0) {
        this.seq++;
        this.persistLines(`${JSON.stringify({ seq: this.seq, mark: 'comments' })}\n`, 1);
      }
      return;
    }
    const at = new Date().toISOString();
    const actor = event.origin?.actorId ?? 'system';
    const added: ChangeEntry[] = [];
    for (const change of event.changes) {
      const entry: ChangeEntry = { seq: ++this.seq, at, actor, kind: change.kind, id: change.id };
      if (change.fields && change.fields.length > 0) entry.fields = [...change.fields];
      if (change.title !== undefined) entry.title = change.title;
      if (tag.reason !== undefined) entry.reason = tag.reason;
      if (tag.batchId !== undefined) entry.batchId = tag.batchId;
      added.push(entry);
    }
    this.entries.push(...added);
    if (this.entries.length > this.retain)
      this.entries.splice(0, this.entries.length - this.retain);
    this.persist(added);
  }

  /** Entries newer than `since`, and whether the caller must re-read instead. */
  since(since: number): { entries: ChangeEntry[]; resync: boolean } {
    const oldest = this.entries[0]?.seq;
    // Everything up to `floor` is gone (or never existed in memory).
    const floor = oldest === undefined ? this.seq : oldest - 1;
    const resync = since < floor || since > this.seq;
    return { entries: this.entries.filter((entry) => entry.seq > since), resync };
  }

  /** Resolves once every recorded entry is on disk. */
  flush(): Promise<void> {
    return this.writes;
  }

  private persist(added: ChangeEntry[]): void {
    this.persistLines(added.map((entry) => `${JSON.stringify(entry)}\n`).join(''), added.length);
  }

  private persistLines(text: string, count: number): void {
    this.writes = this.writes.then(async () => {
      try {
        if (this.linesOnDisk + count > this.retain * 2) {
          // Compact: keep the file from growing without bound. The final mark
          // keeps the cursor when the newest change was a comment.
          const kept = this.entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
          await writeFileAtomic(
            this.file,
            `${kept}${JSON.stringify({ seq: this.seq, mark: 'cursor' })}\n`,
          );
          this.linesOnDisk = this.entries.length + 1;
        } else {
          await appendFile(this.file, text);
          this.linesOnDisk += count;
        }
      } catch (error) {
        this.log(`change feed: could not write ${this.file}: ${errorMessage(error)}`);
      }
    });
  }
}

/** The seq of a mark line, or null for any other line. */
function parseMark(line: string): number | null {
  try {
    const raw = JSON.parse(line) as { seq?: unknown; mark?: unknown };
    return typeof raw.mark === 'string' && typeof raw.seq === 'number' && Number.isInteger(raw.seq)
      ? raw.seq
      : null;
  } catch {
    return null;
  }
}

function parseEntry(line: string): ChangeEntry | null {
  try {
    const raw = JSON.parse(line) as Partial<ChangeEntry>;
    if (
      typeof raw.seq !== 'number' ||
      !Number.isInteger(raw.seq) ||
      typeof raw.at !== 'string' ||
      typeof raw.actor !== 'string' ||
      typeof raw.id !== 'string' ||
      !ChangeKindSchema.safeParse(raw.kind).success
    ) {
      return null;
    }
    const entry: ChangeEntry = {
      seq: raw.seq,
      at: raw.at,
      actor: raw.actor,
      kind: raw.kind as ChangeEntry['kind'],
      id: raw.id,
    };
    if (Array.isArray(raw.fields)) entry.fields = raw.fields.filter((f) => typeof f === 'string');
    if (typeof raw.title === 'string') entry.title = raw.title;
    if (typeof raw.reason === 'string') entry.reason = raw.reason;
    if (typeof raw.batchId === 'string') entry.batchId = raw.batchId;
    return entry;
  } catch {
    return null;
  }
}
