import type { ChangeEntry, ChangesOptions, ChangesResult } from '@openboard/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT, ME, sampleDoc } from '../test/fixtures.js';
import type { Clock } from './activity.js';
import {
  ADVANCE_MS,
  CHANGED_MESSAGE,
  decideNotice,
  type FeedSince,
  isVisitMarker,
  latestByOthers,
  localVisitStorage,
  markerNow,
  type PageVisibility,
  showable,
  summarize,
  type VisitMarker,
  type VisitStorage,
  VisitStore,
  visitKey,
  visitMessage,
} from './lastVisit.js';

const PEER = { id: 'a_peer000001', kind: 'human' as const, name: 'Grace' };
const ACTORS = { [ME.id]: ME, [AGENT.id]: AGENT, [PEER.id]: PEER };

let seq = 0;
function entry(actor: string, kind: ChangeEntry['kind'], id: string): ChangeEntry {
  return { seq: ++seq, at: '2026-11-15T10:00:00.000Z', actor, kind, id };
}

function feed(entries: ChangeEntry[], extra: Partial<FeedSince> = {}): FeedSince {
  return { cursor: 100, entries, resync: false, complete: true, ...extra };
}

const marker = (extra: Partial<VisitMarker> = {}): VisitMarker => ({
  lineage: 'l_one',
  cursor: 10,
  seen: '2026-11-15T09:00:00.000Z',
  ...extra,
});

describe('markers', () => {
  it('accepts only well-formed markers', () => {
    expect(isVisitMarker(marker())).toBe(true);
    expect(isVisitMarker(marker({ lineage: null }))).toBe(true);
    expect(isVisitMarker({ cursor: 3 })).toBe(false);
    expect(isVisitMarker(marker({ cursor: -1 }))).toBe(false);
    expect(isVisitMarker(marker({ cursor: 1.5 }))).toBe(false);
    expect(isVisitMarker('10')).toBe(false);
    expect(isVisitMarker(null)).toBe(false);
  });

  it('is stored per board under a namespaced key', () => {
    expect(visitKey('checkout')).toBe('lastVisit.checkout');
    localVisitStorage.write('checkout', marker());
    expect(localStorage.getItem('openboard.lastVisit.checkout')).not.toBeNull();
    expect(localVisitStorage.read('checkout')).toEqual(marker());
    expect(localVisitStorage.read('other')).toBeUndefined();
    localStorage.clear();
  });

  it('reads and writes nothing, without throwing, when storage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => localVisitStorage.write('checkout', marker())).not.toThrow();
    expect(localVisitStorage.read('checkout')).toBeUndefined();
    spy.mockRestore();
    set.mockRestore();
  });

  it('takes the cursor and lineage the server has now', () => {
    expect(markerNow({ lineage: 'l_two', seen: 'x' }, 3)).toEqual({
      lineage: 'l_two',
      cursor: 3,
      seen: 'x',
    });
  });

  it('takes the newest change by someone else from the board', () => {
    const items = [
      { updatedAt: '2026-11-15T10:00:00.000Z', updatedBy: AGENT.id },
      { updatedAt: '2026-11-15T12:00:00.000Z', updatedBy: ME.id },
      { updatedAt: '2026-11-15T11:00:00.000Z', updatedBy: PEER.id },
    ];
    expect(latestByOthers(items, ME.id)).toBe('2026-11-15T11:00:00.000Z');
    expect(latestByOthers([], ME.id)).toBe('');
  });
});

describe('summarize', () => {
  it('counts each item once per actor with what they did to it overall', () => {
    const summary = summarize(
      [
        entry(AGENT.id, 'node_added', 'n1'),
        entry(AGENT.id, 'node_updated', 'n1'),
        entry(AGENT.id, 'node_updated', 'n2'),
        entry(AGENT.id, 'node_updated', 'n2'),
        entry(PEER.id, 'node_updated', 'n2'),
        entry(PEER.id, 'node_removed', 'n3'),
        entry(PEER.id, 'edge_added', 'e1'),
      ],
      ME.id,
    );
    expect(summary.total).toBe(5);
    expect(summary.items).toEqual([
      { kind: 'node', id: 'n1', actorId: AGENT.id, verb: 'added' },
      { kind: 'node', id: 'n2', actorId: AGENT.id, verb: 'changed' },
      { kind: 'node', id: 'n2', actorId: PEER.id, verb: 'changed' },
      { kind: 'node', id: 'n3', actorId: PEER.id, verb: 'removed' },
      { kind: 'edge', id: 'e1', actorId: PEER.id, verb: 'added' },
    ]);
  });

  it('leaves out the person, moves, layout, code-link upkeep, and what came and went', () => {
    const moved = entry(AGENT.id, 'node_moved', 'n1');
    const layout = { ...entry(AGENT.id, 'node_updated', 'n2'), source: 'layout' as const };
    const code = { ...entry('system', 'node_updated', 'n3'), source: 'code' as const };
    const summary = summarize(
      [
        entry(ME.id, 'node_added', 'mine'),
        moved,
        layout,
        code,
        entry(AGENT.id, 'node_added', 'brief'),
        entry(AGENT.id, 'node_removed', 'brief'),
      ],
      ME.id,
    );
    expect(summary).toEqual({ items: [], total: 0 });
  });

  it('names who did what with the real actor names', () => {
    const summary = summarize(
      [
        ...['a', 'b', 'c', 'd', 'e'].map((id) => entry(AGENT.id, 'node_updated', id)),
        entry(PEER.id, 'node_added', 'f'),
        entry(PEER.id, 'node_added', 'g'),
      ],
      ME.id,
    );
    expect(visitMessage(summary, ACTORS)).toBe(
      '7 changes since your last visit: planner changed 5 cards, Grace added 2 cards.',
    );
  });

  it('says what each actor did in one sentence', () => {
    const summary = summarize(
      [
        entry(PEER.id, 'node_added', 'a'),
        entry(PEER.id, 'edge_added', 'e1'),
        entry(PEER.id, 'node_updated', 'b'),
        entry(PEER.id, 'node_removed', 'c'),
        entry('a_unknown0001', 'node_updated', 'd'),
      ],
      ME.id,
    );
    expect(visitMessage(summary, ACTORS)).toBe(
      '5 changes since your last visit: Grace added 1 card and 1 connection, changed 1 card and removed 1 card, Someone changed 1 card.',
    );
  });
});

describe('decideNotice', () => {
  const now = { lineage: 'l_one', seen: '2026-11-15T09:00:00.000Z' };

  it('says nothing when only the person changed the board', () => {
    expect(decideNotice(marker(), now, feed([entry(ME.id, 'node_added', 'n1')]), ME.id)).toBe(null);
  });

  it('gives details when the feed since the marker is complete', () => {
    const notice = decideNotice(marker(), now, feed([entry(AGENT.id, 'node_added', 'n1')]), ME.id);
    expect(notice).toMatchObject({ kind: 'changes', since: 10, summary: { total: 1 } });
  });

  it('falls back to "changed", without details, when the feed was trimmed', () => {
    const later = { ...now, seen: '2026-11-15T11:00:00.000Z' };
    const trimmed = feed([entry(AGENT.id, 'node_added', 'n1')], { resync: true });
    expect(decideNotice(marker(), later, trimmed, ME.id)).toEqual({ kind: 'changed' });
    expect(decideNotice(marker(), later, feed([], { complete: false }), ME.id)).toEqual({
      kind: 'changed',
    });
  });

  it('falls back to "changed" for another lineage, only when the board shows a newer change', () => {
    const other = { lineage: 'l_two', seen: '2026-11-15T09:00:00.000Z' };
    expect(decideNotice(marker(), other, null, ME.id)).toBe(null);
    const newer = { lineage: 'l_two', seen: '2026-11-15T11:00:00.000Z' };
    expect(decideNotice(marker(), newer, null, ME.id)).toEqual({ kind: 'changed' });
    // Even a feed that happens to answer is not trusted across lineages.
    expect(
      decideNotice(marker(), newer, feed([entry(AGENT.id, 'node_added', 'n1')]), ME.id),
    ).toEqual({ kind: 'changed' });
  });

  it('points only at what is still on the board, and never for a plain "changed"', () => {
    const notice = decideNotice(
      marker(),
      now,
      feed([
        entry(AGENT.id, 'node_updated', 'kept'),
        entry(AGENT.id, 'node_updated', 'gone'),
        entry(AGENT.id, 'node_removed', 'removed'),
      ]),
      ME.id,
    );
    expect(showable(notice, (_kind, id) => id === 'kept').map((i) => i.id)).toEqual(['kept']);
    expect(showable({ kind: 'changed' }, () => true)).toEqual([]);
    expect(CHANGED_MESSAGE).toBe('This board changed since your last visit.');
  });
});

// ── The store ───────────────────────────────────────────────────────────────

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.fn();
    }
  };
  return { clock, advance };
}

function memoryStorage(initial?: VisitMarker): VisitStorage & { value: VisitMarker | undefined } {
  const store = {
    value: initial,
    read: () => store.value,
    write: (_boardId: string, marker: VisitMarker) => {
      store.value = marker;
    },
  };
  return store;
}

function fakePage(): PageVisibility & { set(visible: boolean): void } {
  let visible = true;
  const listeners = new Set<() => void>();
  return {
    visible: () => visible,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      visible = next;
      for (const listener of listeners) listener();
    },
  };
}

/** A change feed: entries by `seq`, answering like the server (own changes left out). */
function fakeFeed(lineageCursor = { cursor: 0 }) {
  const entries: ChangeEntry[] = [];
  const changes = vi.fn(async (boardId: string, opts: ChangesOptions): Promise<ChangesResult> => {
    const after = entries.filter((e) => e.seq > opts.since && e.actor !== ME.id);
    return {
      boardId,
      since: opts.since,
      cursor: lineageCursor.cursor,
      changes: opts.since > lineageCursor.cursor ? [] : after,
      resync: opts.since > lineageCursor.cursor,
      text: '',
      tokens: 0,
      truncated: false,
    };
  });
  const add = (actor: string, kind: ChangeEntry['kind'], id: string) => {
    lineageCursor.cursor++;
    entries.push({ seq: lineageCursor.cursor, at: new Date().toISOString(), actor, kind, id });
  };
  return { changes, add, state: lineageCursor };
}

function storeFor(opts: {
  storage: VisitStorage;
  lineage?: string;
  feed: ReturnType<typeof fakeFeed>;
}) {
  const doc = sampleDoc();
  const { clock, advance } = fakeClock();
  const page = fakePage();
  const store = new VisitStore({
    boardId: 'test-board',
    lineage: opts.lineage ?? 'l_one',
    me: () => ME.id,
    api: { changes: opts.feed.changes },
    doc,
    storage: opts.storage,
    page,
    clock,
  });
  return { store, doc, advance, page };
}

describe('VisitStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows nothing on the first visit and keeps a marker', async () => {
    const feed = fakeFeed({ cursor: 7 });
    const storage = memoryStorage();
    const { store } = storeFor({ storage, feed });
    store.start();
    await store.idle();
    expect(store.get()).toBe(null);
    expect(storage.value).toMatchObject({ lineage: 'l_one', cursor: 7 });
    store.destroy();
  });

  it('stops quietly when storage keeps nothing', async () => {
    const feed = fakeFeed({ cursor: 7 });
    const storage: VisitStorage = { read: () => undefined, write: () => {} };
    const { store, doc, advance } = storeFor({ storage, feed });
    store.start();
    await store.idle();
    feed.changes.mockClear();
    doc.apply([{ op: 'update_node', id: 'note1', patch: { title: 'Edited' } }], { actor: AGENT });
    advance(ADVANCE_MS);
    await store.idle();
    expect(feed.changes).not.toHaveBeenCalled();
    expect(store.get()).toBe(null);
  });

  it('tells what others changed since the marker, then counts from the new one', async () => {
    const feed = fakeFeed({ cursor: 10 });
    feed.add(AGENT.id, 'node_updated', 'task1');
    feed.add(PEER.id, 'node_added', 'note1');
    const storage = memoryStorage(marker({ cursor: 10 }));
    const { store } = storeFor({ storage, feed });
    store.start();
    await store.idle();
    expect(store.get()).toMatchObject({ kind: 'changes', since: 10, summary: { total: 2 } });
    expect(storage.value?.cursor).toBe(12);

    store.dismiss();
    await store.idle();
    expect(store.get()).toBe(null);
    expect(storage.value?.cursor).toBe(12);
  });

  it('moves the marker along while the board is in view, but not while hidden', async () => {
    const feed = fakeFeed({ cursor: 3 });
    const storage = memoryStorage(marker({ cursor: 3 }));
    const { store, doc, advance, page } = storeFor({ storage, feed });
    store.start();
    await store.idle();
    expect(store.get()).toBe(null);

    // Watched: the marker follows, so the next visit does not repeat it.
    feed.add(AGENT.id, 'node_updated', 'task1');
    doc.apply([{ op: 'update_node', id: 'task1', patch: { title: 'Watched' } }], { actor: AGENT });
    advance(ADVANCE_MS);
    await store.idle();
    expect(storage.value?.cursor).toBe(4);

    // Hidden: the marker stays, and coming back tells what happened meanwhile.
    page.set(false);
    feed.add(PEER.id, 'node_updated', 'note1');
    doc.apply([{ op: 'update_node', id: 'note1', patch: { title: 'Unseen' } }], { actor: PEER });
    advance(ADVANCE_MS);
    await store.idle();
    expect(storage.value?.cursor).toBe(4);
    page.set(true);
    await store.idle();
    expect(store.get()).toMatchObject({
      kind: 'changes',
      summary: { items: [{ id: 'note1', actorId: PEER.id, verb: 'changed' }] },
    });
    expect(storage.value?.cursor).toBe(5);
    store.destroy();
  });

  it('says only "changed" when the server came back with another lineage', async () => {
    const feed = fakeFeed({ cursor: 2 });
    // The marker predates the agent's edits in the sample board.
    const storage = memoryStorage(marker({ lineage: 'l_old', cursor: 40, seen: '' }));
    const { store } = storeFor({ storage, feed, lineage: 'l_new' });
    store.start();
    await store.idle();
    expect(store.get()).toEqual({ kind: 'changed' });
    expect(storage.value).toMatchObject({ lineage: 'l_new', cursor: 2 });
    store.destroy();
  });

  it('says nothing when the feed was reset and nobody else changed the board', async () => {
    const feed = fakeFeed({ cursor: 2 });
    const storage = memoryStorage();
    const { store, doc } = storeFor({ storage, feed });
    storage.value = marker({
      cursor: 40,
      seen: latestByOthers([...doc.nodes(), ...doc.edges()], ME.id),
    });
    store.start();
    await store.idle();
    expect(store.get()).toBe(null);
    expect(storage.value?.cursor).toBe(2);
    store.destroy();
  });
});
