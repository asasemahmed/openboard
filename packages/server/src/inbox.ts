/**
 * The inbox of one board: items addressed to actors (mentions, replies,
 * answers, decisions, undone batches) and how far each actor has read.
 *
 * Positions are one sequence per board: every item gets the next `seq`, and an
 * actor's position is the `seq` of the newest item it has seen. Stored in
 * `.local/<id>.inbox.jsonl` as `{"to", "item"}` and `{"seen", "position"}`
 * lines, compacted when the file is opened.
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
        if (typeof raw.seen === 'string' && typeof raw.position === 'number') {
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
    const compactLines = inbox.items.length + inbox.seen.size + 1;
    if (lines.length > compactLines) await inbox.compact();
    else inbox.linesOnDisk = lines.length;
    return inbox;
  }

  /** The newest position on this board. */
  get position(): number {
    return this.seq;
  }

  /** Add an item for `to`. Never deliver an actor's own action to itself: the caller checks `from`. */
  deliver(to: string, item: Omit<InboxItem, 'seq' | 'at'> & { at?: string }): InboxItem {
    const full: InboxItem = { ...item, seq: ++this.seq, at: item.at ?? new Date().toISOString() };
    this.items.push({ to, item: full });
    if (this.items.length > this.retain) this.items.splice(0, this.items.length - this.retain);
    this.append(`${JSON.stringify({ to, item: full })}\n`);
    return full;
  }

  /** Items for `actor` after `since` (default: after what it has seen), oldest first. */
  unread(actor: string, since?: number): InboxItem[] {
    const from = since ?? this.seen.get(actor) ?? 0;
    return this.items.filter((s) => s.to === actor && s.item.seq > from).map((s) => s.item);
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
    // Keeps the sequence when the newest items were dropped.
    lines.push(JSON.stringify({ seq: this.seq }));
    return `${lines.join('\n')}\n`;
  }

  private compact(): Promise<void> {
    const text = this.snapshot();
    const count = this.items.length + this.seen.size + 1;
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
