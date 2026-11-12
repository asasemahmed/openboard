/**
 * The inbox of one board: items addressed to actors (mentions, replies,
 * answers, decisions, undone batches) and how far each actor has read.
 *
 * Positions are one sequence per board: every item gets the next `seq`, and an
 * actor's position is the `seq` of the newest item it has seen. Stored in
 * `.local/<id>.inbox.jsonl` as `{"to", "item"}`, `{"seen", "position"}` and
 * `{"dismissed", "seqs"}` lines, compacted when the file is opened. A
 * dismissed item already reached its actor another way (an answer returned by
 * a long-poll) and is skipped by reads that do not pass `since`.
 */
import { appendFile, readFile } from 'node:fs/promises';
import type { InboxItem } from '@openboard/core';
import { errorMessage, isErrno, writeFileAtomic } from './fsutil.js';

/** Items kept per board (across all recipients). */
export const INBOX_RETAIN = 5000;

interface Stored {
  to: string;
  item: InboxItem;
}

export class Inbox {
  private items: Stored[] = [];
  private seq = 0;
  private readonly seen = new Map<string, number>();
  private readonly dismissed = new Set<number>();
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
  ): Promise<Inbox> {
    const inbox = new Inbox(file, opts.retain ?? INBOX_RETAIN, opts.log ?? (() => {}));
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    for (const line of lines) {
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        if (typeof raw.dismissed === 'string' && Array.isArray(raw.seqs)) {
          for (const seq of raw.seqs) if (typeof seq === 'number') inbox.dismissed.add(seq);
        } else if (typeof raw.seen === 'string' && typeof raw.position === 'number') {
          inbox.seen.set(raw.seen, Math.max(inbox.seen.get(raw.seen) ?? 0, raw.position));
        } else if (
          typeof raw.to === 'string' &&
          typeof raw.item === 'object' &&
          raw.item !== null
        ) {
          const item = raw.item as InboxItem;
          if (typeof item.seq === 'number' && item.seq > inbox.seq) {
            inbox.items.push({ to: raw.to, item });
            inbox.seq = item.seq;
          }
        } else if (typeof raw.seq === 'number') {
          inbox.seq = Math.max(inbox.seq, raw.seq);
        }
      } catch {
        // A torn last line; skip it.
      }
    }
    inbox.items = inbox.items.slice(-inbox.retain);
    const kept = new Set(inbox.items.map((stored) => stored.item.seq));
    for (const seq of [...inbox.dismissed]) if (!kept.has(seq)) inbox.dismissed.delete(seq);
    const compactLines =
      inbox.items.length + inbox.seen.size + 1 + (inbox.dismissed.size > 0 ? 1 : 0);
    if (lines.length > compactLines) await inbox.compact();
    else inbox.linesOnDisk = lines.length;
    return inbox;
  }

  /** The newest position on this board. */
  get position(): number {
    return this.seq;
  }

  /** Called with the recipient after every delivery. */
  onDeliver: ((to: string) => void) | null = null;

  /** Add an item for `to`. Never deliver an actor's own action to itself: the caller checks `from`. */
  deliver(to: string, item: Omit<InboxItem, 'seq' | 'at'> & { at?: string }): InboxItem {
    const full: InboxItem = { ...item, seq: ++this.seq, at: item.at ?? new Date().toISOString() };
    this.items.push({ to, item: full });
    if (this.items.length > this.retain) this.items.splice(0, this.items.length - this.retain);
    this.append(`${JSON.stringify({ to, item: full })}\n`);
    this.onDeliver?.(to);
    return full;
  }

  /** Items for `actor` after `since` (default: after what it has seen), oldest first. */
  unread(actor: string, since?: number): InboxItem[] {
    const from = since ?? this.seen.get(actor) ?? 0;
    return this.items
      .filter(
        (stored) =>
          stored.to === actor &&
          stored.item.seq > from &&
          (since !== undefined || !this.dismissed.has(stored.item.seq)),
      )
      .map((stored) => stored.item);
  }

  /** Items for `actor` that match `test`, read or not. */
  find(actor: string, test: (item: InboxItem) => boolean): InboxItem[] {
    return this.items
      .filter((stored) => stored.to === actor && test(stored.item))
      .map((stored) => stored.item);
  }

  /** Leave these items of `actor` out of later unread reads: they reached it another way. */
  dismiss(actor: string, seqs: number[]): void {
    const fresh = seqs.filter((seq) => !this.dismissed.has(seq));
    if (fresh.length === 0) return;
    for (const seq of fresh) this.dismissed.add(seq);
    this.append(`${JSON.stringify({ dismissed: actor, seqs: fresh })}\n`);
  }

  /** Remember that `actor` has seen everything up to `position`. Positions never move back. */
  markSeen(actor: string, position: number): void {
    if (position <= (this.seen.get(actor) ?? 0)) return;
    this.seen.set(actor, position);
    this.append(`${JSON.stringify({ seen: actor, position })}\n`);
  }

  flush(): Promise<void> {
    return this.writes;
  }

  private snapshot(): string {
    const lines = this.items.map((s) => JSON.stringify({ to: s.to, item: s.item }));
    for (const [actor, position] of this.seen)
      lines.push(JSON.stringify({ seen: actor, position }));
    if (this.dismissed.size > 0) {
      lines.push(JSON.stringify({ dismissed: '*', seqs: [...this.dismissed] }));
    }
    // Keeps the sequence when the newest items were dropped.
    lines.push(JSON.stringify({ seq: this.seq }));
    return `${lines.join('\n')}\n`;
  }

  private compact(): Promise<void> {
    const text = this.snapshot();
    const count = this.items.length + this.seen.size + 1 + (this.dismissed.size > 0 ? 1 : 0);
    this.writes = this.writes.then(async () => {
      try {
        await writeFileAtomic(this.file, text);
        this.linesOnDisk = count;
      } catch (error) {
        this.log(`inbox: could not write ${this.file}: ${errorMessage(error)}`);
      }
    });
    return this.writes;
  }

  private append(line: string): void {
    if (this.linesOnDisk + 1 > this.retain * 2) {
      void this.compact();
      return;
    }
    this.linesOnDisk++;
    this.writes = this.writes.then(async () => {
      try {
        await appendFile(this.file, line);
      } catch (error) {
        this.log(`inbox: could not write ${this.file}: ${errorMessage(error)}`);
      }
    });
  }
}
