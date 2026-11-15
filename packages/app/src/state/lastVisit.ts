/**
 * What changed while the person was away. For each board the browser keeps
 * the board as the person last saw it (a `VisitMarker`); when they open the
 * board again, the change feed since that marker says who did what, and a
 * small notice tells them.
 *
 * The marker is the feed cursor together with the document's lineage. The
 * cursor survives a server restart (the feed is on disk), and the lineage
 * says whether it still counts in the same feed: a document rebuilt from the
 * board file starts a new feed with a new lineage. When the marker cannot be
 * resolved (another lineage, a cursor the feed no longer holds), there are no
 * per-card details: the notice only says the board changed, and only when
 * the board itself shows that someone else changed something since.
 *
 * The rules are pure functions, tested without a server. `VisitStore` runs
 * them for one session: it checks once the document has synced (and again
 * when a hidden tab comes back), and moves the marker along while the board
 * is in view, so nobody is told about changes they watched happen.
 */
import {
  type Actor,
  type BoardEdge,
  type BoardNode,
  type ChangeEntry,
  type ChangesResult,
  type DocEvent,
  MAX_MAX_TOKENS,
  SYSTEM_ACTOR,
} from '@openboard/core';
import type { ApiClient } from '../lib/api.js';
import { readStored, writeStored } from '../lib/storage.js';
import { type Clock, type ItemKind, systemClock } from './activity.js';
import { Emitter } from './emitter.js';

/** The board as the person last saw it. */
export interface VisitMarker {
  /** The lineage of the live document; null when the server does not say. */
  lineage: string | null;
  /** The change feed cursor. */
  cursor: number;
  /** The newest `updatedAt` among nodes and edges others last changed (ISO), or "". */
  seen: string;
}

export function isVisitMarker(value: unknown): value is VisitMarker {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.lineage === null || typeof v.lineage === 'string') &&
    typeof v.cursor === 'number' &&
    Number.isSafeInteger(v.cursor) &&
    v.cursor >= 0 &&
    typeof v.seen === 'string'
  );
}

/** The storage key of a board's marker (under the app's `openboard.` prefix). */
export function visitKey(boardId: string): string {
  return `lastVisit.${boardId}`;
}

/** Where markers are kept. The default is localStorage, which never throws. */
export interface VisitStorage {
  read(boardId: string): VisitMarker | undefined;
  write(boardId: string, marker: VisitMarker): void;
}

export const localVisitStorage: VisitStorage = {
  read: (boardId) => readStored(visitKey(boardId), isVisitMarker),
  write: (boardId, marker) => writeStored(visitKey(boardId), marker),
};

/**
 * The newest change others made that is still on the board: the latest
 * `updatedAt` of a node or edge someone other than `me` last changed.
 * Moves and code-link upkeep do not move `updatedAt`, so neither counts.
 */
export function latestByOthers(
  items: Iterable<Pick<BoardNode | BoardEdge, 'updatedAt' | 'updatedBy'>>,
  me: string,
): string {
  let latest = '';
  for (const item of items) {
    if (item.updatedBy !== me && item.updatedAt > latest) latest = item.updatedAt;
  }
  return latest;
}

// ── Summarising the change feed ─────────────────────────────────────────────

export type VisitVerb = 'added' | 'changed' | 'removed';

/** One card or connection someone changed, with what they did to it overall. */
export interface VisitItem {
  kind: ItemKind;
  id: string;
  actorId: string;
  verb: VisitVerb;
}

export interface VisitSummary {
  /** Per actor, in the order they first appear in the feed. */
  items: VisitItem[];
  total: number;
}

/**
 * Fold feed entries into what each actor did to each item: added (even if
 * they changed it after), changed, or removed. An item someone added and
 * removed again is left out. Entries by `me`, moves and code-link upkeep
 * are skipped.
 */
export function summarize(entries: readonly ChangeEntry[], me: string): VisitSummary {
  const byKey = new Map<string, VisitItem>();
  for (const entry of entries) {
    if (entry.actor === me || entry.kind === 'node_moved') continue;
    if (entry.source === 'code' || entry.source === 'layout') continue;
    const kind: ItemKind = entry.kind.startsWith('node_') ? 'node' : 'edge';
    const key = `${entry.actor}\u0000${kind}:${entry.id}`;
    const previous = byKey.get(key);
    if (entry.kind.endsWith('_added')) {
      byKey.set(key, { kind, id: entry.id, actorId: entry.actor, verb: 'added' });
    } else if (entry.kind.endsWith('_removed')) {
      if (previous?.verb === 'added') byKey.delete(key);
      else byKey.set(key, { kind, id: entry.id, actorId: entry.actor, verb: 'removed' });
    } else if (!previous || previous.verb === 'removed') {
      byKey.set(key, { kind, id: entry.id, actorId: entry.actor, verb: 'changed' });
    }
  }
  const items = [...byKey.values()];
  return { items, total: items.length };
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "planner changed 5 cards", "Grace added 2 cards and removed 1 connection". */
function actorSentence(name: string, items: readonly VisitItem[]): string {
  const parts: string[] = [];
  for (const verb of ['added', 'changed', 'removed'] as const) {
    const cards = items.filter((i) => i.verb === verb && i.kind === 'node').length;
    const links = items.filter((i) => i.verb === verb && i.kind === 'edge').length;
    const what = [
      cards ? count(cards, 'card') : '',
      links ? count(links, 'connection') : '',
    ].filter(Boolean);
    if (what.length > 0) parts.push(`${verb} ${what.join(' and ')}`);
  }
  const last = parts.pop() ?? '';
  return `${name} ${parts.length > 0 ? `${parts.join(', ')} and ${last}` : last}`;
}

/** The display name for a feed actor, or "Someone". */
export function visitActorName(actors: Readonly<Record<string, Actor>>, id: string): string {
  if (Object.hasOwn(actors, id)) return actors[id]?.name ?? 'Someone';
  return id === SYSTEM_ACTOR.id ? SYSTEM_ACTOR.name : 'Someone';
}

/** "7 changes since your last visit: planner changed 5 cards, Grace added 2 cards." */
export function visitMessage(
  summary: VisitSummary,
  actors: Readonly<Record<string, Actor>>,
): string {
  const byActor = new Map<string, VisitItem[]>();
  for (const item of summary.items) {
    const list = byActor.get(item.actorId);
    if (list) list.push(item);
    else byActor.set(item.actorId, [item]);
  }
  const sentences = [...byActor].map(([id, items]) =>
    actorSentence(visitActorName(actors, id), items),
  );
  return `${count(summary.total, 'change')} since your last visit: ${sentences.join(', ')}.`;
}

export const CHANGED_MESSAGE = 'This board changed since your last visit.';

// ── Deciding what to tell ───────────────────────────────────────────────────

/** What the notice says. `since` is the cursor a later check counts from. */
export type VisitNotice =
  | { kind: 'changes'; since: number; summary: VisitSummary }
  | { kind: 'changed' };

/** The board as it is now, as far as a check needs it. */
export interface VisitNow {
  lineage: string | null;
  /** `latestByOthers` of the board now. */
  seen: string;
}

/** The change feed since the marker: every page, or `complete: false` when it was cut short. */
export interface FeedSince {
  cursor: number;
  entries: ChangeEntry[];
  resync: boolean;
  complete: boolean;
}

/** Whether a marker still counts in the current feed. */
export function sameFeed(marker: VisitMarker, lineage: string | null): boolean {
  return marker.lineage === null || lineage === null || marker.lineage === lineage;
}

/**
 * What to tell a person coming back, given their marker and the feed since.
 * Null means say nothing. Without a usable feed (another lineage, a trimmed
 * or reset feed, too many changes to read) it falls back to "changed", and
 * only when the board shows a newer change by someone else than the marker.
 */
export function decideNotice(
  marker: VisitMarker,
  now: VisitNow,
  feed: FeedSince | null,
  me: string,
): VisitNotice | null {
  const usable = feed !== null && sameFeed(marker, now.lineage) && !feed.resync && feed.complete;
  if (!usable) return now.seen > marker.seen ? { kind: 'changed' } : null;
  const summary = summarize(feed.entries, me);
  if (summary.total === 0) return null;
  return { kind: 'changes', since: marker.cursor, summary };
}

/**
 * The marker for the board as it is now. The cursor is the server's: a
 * stored one ahead of it belongs to a feed that was reset, and must not stick.
 */
export function markerNow(now: VisitNow, cursor: number): VisitMarker {
  return { lineage: now.lineage, cursor, seen: now.seen };
}

/** Items of a notice that are still on the board and can be pointed at. */
export function showable(
  notice: VisitNotice | null,
  exists: (kind: ItemKind, id: string) => boolean,
): VisitItem[] {
  if (notice?.kind !== 'changes') return [];
  return notice.summary.items.filter((i) => i.verb !== 'removed' && exists(i.kind, i.id));
}

// ── The store ───────────────────────────────────────────────────────────────

/** How many pages of the feed a check reads before settling for "changed". */
const MAX_PAGES = 5;
/** How long the board must be quiet before the marker moves along. */
export const ADVANCE_MS = 1500;

/** Whether the page is in view, and a way to hear when that changes. */
export interface PageVisibility {
  visible(): boolean;
  onChange(listener: () => void): () => void;
}

export const documentVisibility: PageVisibility = {
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  onChange(listener) {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};

export interface VisitOptions {
  boardId: string;
  lineage: string | null;
  me: () => string;
  api: Pick<ApiClient, 'changes'>;
  doc: {
    nodes(): BoardNode[];
    edges(): BoardEdge[];
    observe(listener: (event: DocEvent) => void): () => void;
  };
  storage?: VisitStorage;
  page?: PageVisibility;
  clock?: Clock;
}

export class VisitStore extends Emitter {
  private notice: VisitNotice | null = null;
  private readonly opts: VisitOptions;
  private readonly storage: VisitStorage;
  private readonly page: PageVisibility;
  private readonly clock: Clock;
  private started = false;
  /** True once the first check has stored a marker; until then nothing advances it. */
  private ready = false;
  private away = false;
  private running: Promise<void> = Promise.resolve();
  private timer: unknown = null;
  private destroyed = false;
  private readonly offs: Array<() => void> = [];

  constructor(opts: VisitOptions) {
    super();
    this.opts = opts;
    this.storage = opts.storage ?? localVisitStorage;
    this.page = opts.page ?? documentVisibility;
    this.clock = opts.clock ?? systemClock;
  }

  readonly get = (): VisitNotice | null => this.notice;

  /** Begin: called once the document has synced. */
  start(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.offs.push(this.opts.doc.observe(() => this.schedule()));
    this.offs.push(
      this.page.onChange(() => {
        if (!this.page.visible()) {
          this.away = true;
          return;
        }
        if (!this.away) return;
        this.away = false;
        this.queue(() => this.check());
      }),
    );
    this.away = !this.page.visible();
    this.queue(() => this.check());
  }

  /** Clear the notice and remember the board as it is now. */
  dismiss(): void {
    if (this.notice !== null) {
      this.notice = null;
      this.emit();
    }
    this.queue(() => this.advance());
  }

  /** Resolves when every queued check and advance has finished (tests). */
  idle(): Promise<void> {
    return this.running;
  }

  destroy(): void {
    this.destroyed = true;
    for (const off of this.offs.splice(0)) off();
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private queue(task: () => Promise<void>): void {
    this.running = this.running.then(async () => {
      if (this.destroyed) return;
      try {
        await task();
      } catch {
        // A failed read leaves the marker where it was; the next visit tries again.
      }
    });
  }

  private now(): VisitNow {
    const me = this.opts.me();
    const { doc } = this.opts;
    return {
      lineage: this.opts.lineage,
      seen: latestByOthers([...doc.nodes(), ...doc.edges()], me),
    };
  }

  private async currentCursor(): Promise<number> {
    // A cursor past the end returns no entries, only the current cursor.
    const result = await this.opts.api.changes(this.opts.boardId, {
      since: Number.MAX_SAFE_INTEGER,
      maxTokens: 100,
    });
    return result.cursor;
  }

  private async feedSince(since: number): Promise<FeedSince> {
    const entries: ChangeEntry[] = [];
    let from = since;
    let resync = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result: ChangesResult = await this.opts.api.changes(this.opts.boardId, {
        since: from,
        excludeSources: ['code', 'layout'],
        maxTokens: MAX_MAX_TOKENS,
      });
      resync ||= result.resync;
      entries.push(...result.changes);
      if (!result.truncated) return { cursor: result.cursor, entries, resync, complete: true };
      if (result.cursor <= from) break;
      from = result.cursor;
    }
    return { cursor: await this.currentCursor(), entries, resync, complete: false };
  }

  private async check(): Promise<void> {
    const { boardId } = this.opts;
    const stored = this.storage.read(boardId);
    const now = this.now();
    if (!stored) {
      // The first visit: nothing to tell, only a marker to keep.
      const cursor = await this.currentCursor();
      if (this.destroyed) return;
      this.storage.write(boardId, markerNow(this.now(), cursor));
      // Without working storage there is nothing to come back to: stop quietly.
      if (this.storage.read(boardId)) this.ready = true;
      else this.destroy();
      return;
    }
    // A notice still up counts from where it started, so coming back adds to it.
    const pending = this.notice;
    const base: VisitMarker =
      pending?.kind === 'changes' ? { ...stored, cursor: pending.since } : stored;
    const feed = sameFeed(base, now.lineage) ? await this.feedSince(base.cursor) : null;
    if (this.destroyed) return;
    const decided = decideNotice(base, now, feed, this.opts.me());
    const cursor = feed ? feed.cursor : await this.currentCursor();
    if (this.destroyed) return;
    this.storage.write(boardId, markerNow(this.now(), cursor));
    this.ready = true;
    // A notice still up is only ever replaced by details that cover it.
    if (
      decided &&
      (pending === null || (pending.kind === 'changes' && decided.kind === 'changes'))
    ) {
      this.notice = decided;
      this.emit();
    }
  }

  private async advance(): Promise<void> {
    if (!this.ready) return;
    const cursor = await this.currentCursor();
    if (this.destroyed) return;
    const { boardId } = this.opts;
    this.storage.write(boardId, markerNow(this.now(), cursor));
  }

  private schedule(): void {
    if (this.destroyed || this.timer !== null) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      // A hidden tab is not watching: what happens now is told when it comes back.
      if (!this.page.visible()) return;
      this.queue(() => this.advance());
    }, ADVANCE_MS);
  }
}
