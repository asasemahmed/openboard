import type { Batch, Board, Claim, Session } from '@openboard/core';
import { describe, expect, it, vi } from 'vitest';
import {
  cursorAnchor,
  elapsed,
  flattenTree,
  groupByAgent,
  partitionPresence,
  plainLine,
  sessionTree,
  workingCount,
} from '../lib/agents.js';
import { withServerName } from '../lib/identity.js';
import { sampleDoc } from '../test/fixtures.js';
import type { Clock } from './activity.js';
import { activeClaims, ClaimStore, claimChip, nextClaimExpiry } from './claims.js';
import {
  CLOSE_BOARD_NOT_FOUND,
  CLOSE_STALE_DOCUMENT,
  INITIAL_LINEAGE,
  type LineageEvent,
  lineageReducer,
} from './lineage.js';
import { parsePeer } from './presence.js';
import { loadReplayTimeline, ReplayController } from './replay.js';

function fakeClock(start = 0) {
  let now = start;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let next = 1;
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
      await flush();
    }
    now = end;
    await flush();
  };
  return { clock, advance, pending: () => timers.length };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('lineage', () => {
  const run = (events: LineageEvent[]) => events.reduce(lineageReducer, INITIAL_LINEAGE);

  it('connects once the lineage is known, and replaces a stale document', () => {
    let state = run([{ type: 'lineage', lineage: 'l1' }]);
    expect(state).toMatchObject({ phase: 'connecting', lineage: 'l1', generation: 1 });
    state = lineageReducer(state, { type: 'synced' });
    state = lineageReducer(state, { type: 'closed', code: CLOSE_STALE_DOCUMENT, dirty: false });
    expect(state).toMatchObject({
      phase: 'resolving',
      lineage: null,
      lostEdits: false,
      retryInMs: 0,
    });
    state = lineageReducer(state, { type: 'lineage', lineage: 'l2' });
    expect(state).toMatchObject({ phase: 'connecting', lineage: 'l2', generation: 2 });
  });

  it('says so when the stale document had edits the server never saw, until dismissed', () => {
    let state = run([
      { type: 'lineage', lineage: 'l1' },
      { type: 'closed', code: CLOSE_STALE_DOCUMENT, dirty: true },
      { type: 'lineage', lineage: 'l2' },
    ]);
    expect(state.lostEdits).toBe(true);
    // A later clean swap does not hide it.
    state = lineageReducer(state, { type: 'closed', code: CLOSE_STALE_DOCUMENT, dirty: false });
    expect(state.lostEdits).toBe(true);
    expect(lineageReducer(state, { type: 'dismiss' }).lostEdits).toBe(false);
  });

  it('backs off when stale closes repeat, and resets once synced', () => {
    let state = run([
      { type: 'lineage', lineage: 'l1' },
      { type: 'closed', code: CLOSE_STALE_DOCUMENT, dirty: false },
      { type: 'lineage', lineage: 'l1' },
      { type: 'closed', code: CLOSE_STALE_DOCUMENT, dirty: false },
    ]);
    expect(state.retryInMs).toBeGreaterThan(0);
    state = lineageReducer(lineageReducer(state, { type: 'lineage', lineage: 'l3' }), {
      type: 'synced',
    });
    expect(state).toMatchObject({ failures: 0, retryInMs: 0 });
  });

  it('keeps "board not found", retries failed reads, and ignores other closes', () => {
    expect(
      run([
        { type: 'lineage', lineage: 'l' },
        { type: 'closed', code: CLOSE_BOARD_NOT_FOUND, dirty: false },
      ]).phase,
    ).toBe('gone');
    expect(run([{ type: 'lineage-failed', notFound: true }]).phase).toBe('gone');
    const waiting = run([{ type: 'lineage-failed', notFound: false }]);
    expect(waiting).toMatchObject({ phase: 'waiting', retryInMs: 500 });
    expect(lineageReducer(waiting, { type: 'retry' }).phase).toBe('resolving');
    const live = run([{ type: 'lineage', lineage: 'l' }]);
    expect(lineageReducer(live, { type: 'closed', code: 1006, dirty: true })).toBe(live);
  });
});

const at = '2026-11-12T10:00:00.000Z';

describe('presence', () => {
  const entries: Array<[number, unknown]> = [
    [1, { actor: { id: 'a_ada', kind: 'human', name: 'Ada' }, cursor: { x: 1, y: 2 } }],
    [
      2,
      {
        actor: { id: 'planner', kind: 'agent', name: 'Planner' },
        agent: { status: 'reading', focus: ['n1'], session: 's1', at },
      },
    ],
    [
      3,
      {
        actor: { id: 'planner', kind: 'agent', name: 'Planner' },
        agent: { status: 'writing', focus: ['n2'], session: 's2', at },
      },
    ],
    [
      4,
      {
        actor: { id: 'coder', kind: 'agent', name: 'Coder' },
        agent: { status: 'waiting', session: 's9', at },
      },
    ],
    [
      5,
      {
        actor: { id: 'system', kind: 'system', name: 'OpenBoard' },
        live: {
          at,
          sessions: [
            {
              id: 's1',
              actor: 'planner',
              status: 'active',
              startedAt: at,
              lastAt: at,
              recent: [],
              counts: { tools: 2, errors: 0 },
              children: [],
            },
          ],
        },
      },
    ],
    [6, { actor: { id: 'bad', kind: 'agent', name: 'Bad' }, agent: { status: 'dancing', at } }],
  ];

  it('sorts people, agent sessions and the system entry apart', () => {
    const split = partitionPresence(entries, parsePeer);
    expect(split.people.map((p) => p.actor.name)).toEqual(['Ada']);
    expect(split.agents.map((a) => a.key)).toEqual(['coder/s9', 'planner/s1', 'planner/s2']);
    expect(split.live?.sessions.map((s) => s.id)).toEqual(['s1']);
    // Nobody draws a pointer or an avatar for the system entry.
    expect(split.people.some((p) => p.actor.kind === 'system')).toBe(false);
  });

  it('groups sessions under their agent, busiest first, and counts who is working', () => {
    const { agents, live } = partitionPresence(entries, parsePeer);
    const groups = groupByAgent(agents);
    expect(groups.map((g) => [g.actor.id, g.status, g.sessions.length])).toEqual([
      ['planner', 'writing', 2],
      ['coder', 'waiting', 1],
    ]);
    expect(workingCount(agents, live)).toBe(2);
  });

  it('parks the pointer at the top-right corner of the first focused node on the board', () => {
    const map = new Map([
      ['f', { id: 'f', x: 100, y: 100, w: 400, h: 300, frame: true }],
      ['n2', { id: 'n2', parent: 'f', x: 20, y: 40, w: 264, h: 96, frame: false }],
    ]);
    expect(cursorAnchor(['gone', 'n2'], map)).toEqual({ x: 384, y: 140 });
    expect(cursorAnchor(['gone'], map)).toBeNull();
  });
});

const session = (over: Partial<Session> & { id: string }): Session => ({
  actor: 'planner',
  status: 'active',
  startedAt: at,
  lastAt: at,
  recent: [],
  counts: { tools: 0, errors: 0 },
  children: [],
  ...over,
});

describe('session tree', () => {
  it('nests subagents, keeps orphans as roots, and keeps ended parents only for live children', () => {
    const tree = sessionTree([
      session({ id: 'root' }),
      session({ id: 'kid2', parent: 'root', startedAt: '2026-11-12T10:02:00.000Z' }),
      session({ id: 'kid1', parent: 'root', startedAt: '2026-11-12T10:01:00.000Z' }),
      session({ id: 'grandkid', parent: 'kid1' }),
      session({ id: 'orphan', parent: 'gone' }),
      session({ id: 'done', status: 'ended' }),
      session({ id: 'old', status: 'ended' }),
      session({ id: 'late', parent: 'old' }),
    ]);
    expect(flattenTree(tree).map((n) => [n.session.id, n.depth, n.orphan])).toEqual([
      ['root', 0, false],
      ['kid1', 1, false],
      ['grandkid', 2, false],
      ['kid2', 1, false],
      ['orphan', 0, true],
      ['old', 0, false],
      ['late', 1, false],
    ]);
  });

  it('survives a cycle and words running times', () => {
    const tree = sessionTree([
      session({ id: 'a', parent: 'b' }),
      session({ id: 'b', parent: 'a' }),
    ]);
    expect(flattenTree(tree)).toHaveLength(0);
    const start = Date.parse(at);
    expect(elapsed(at, start + 9_000)).toBe('9 s');
    expect(elapsed(at, start + 125_000)).toBe('2 min 05 s');
    expect(elapsed(at, start + 3_725_000)).toBe('1 h 02 min');
    expect(plainLine('rm -rf\u0007 /tmp/x\n\nnext', 12)).toBe('rm -rf /tmp…');
  });
});

describe('claims', () => {
  const claim = (nodeId: string, untilMs: number, over: Partial<Claim> = {}): Claim => ({
    nodeId,
    by: 'planner',
    minutes: 15,
    at,
    until: new Date(untilMs).toISOString(),
    ...over,
  });
  const t0 = Date.parse(at);

  it('counts only claims still in force', () => {
    const claims = [claim('n1', t0 + 60_000), claim('n2', t0 - 1)];
    expect([...activeClaims(claims, t0).keys()]).toEqual(['n1']);
    expect(nextClaimExpiry(claims, t0)).toBe(t0 + 60_000);
    expect(nextClaimExpiry(claims, t0 + 60_000)).toBeNull();
  });

  it('labels the chip with the agent and what its session is doing', () => {
    const actors = { planner: { id: 'planner', kind: 'agent' as const, name: 'Planner agent' } };
    const c = claim('n1', t0 + 10 * 60_000, { session: 's1', note: 'Splitting it' });
    const chip = claimChip(c, actors, [], t0);
    expect(chip.label).toBe('Planner agent · claimed');
    expect(chip.tooltip).toContain('Note: Splitting it');
    expect(chip.tooltip).toContain('10 min left');
    const working = claimChip(
      c,
      actors,
      [
        {
          clientId: 1,
          actor: actors.planner,
          color: '#000',
          key: 'planner/s1',
          session: 's1',
          status: 'working',
          focus: [],
          at,
        },
      ],
      t0,
    );
    expect(working.label).toBe('Planner agent · working');
    const long = { planner: { ...actors.planner, name: 'Repository planning assistant' } };
    expect(claimChip(c, long, [], t0).label).toBe('RA · claimed');
    expect(claimChip(c, long, [], t0).tooltip).toContain('Repository planning assistant');
  });

  it('drops a claim when it runs out, and keeps no timer without claims', async () => {
    const doc = sampleDoc();
    const { clock, advance, pending } = fakeClock(t0);
    const store = new ClaimStore(doc, clock);
    expect(pending()).toBe(0);
    doc.putClaim(claim('risk1', t0 + 5_000), doc.origin('planner', 'ops'));
    expect(store.claimOn('risk1')?.by).toBe('planner');
    expect(pending()).toBe(1);
    const changed = vi.fn();
    store.subscribe(changed);
    await advance(5_001);
    expect(store.claimOn('risk1')).toBeUndefined();
    expect(changed).toHaveBeenCalled();
    expect(pending()).toBe(0);
    store.destroy();
  });
});

describe('identity', () => {
  it('takes the server’s name for the person until they choose one', () => {
    const guest = { id: 'a_1234', name: 'Guest', color: '#000' };
    expect(withServerName(guest, 'sven').name).toBe('sven');
    expect(withServerName({ ...guest, name: 'You' }, 'sven').name).toBe('sven');
    expect(withServerName({ ...guest, name: 'Ada', named: true }, 'sven').name).toBe('Ada');
    expect(withServerName(guest, undefined)).toBe(guest);
  });
});

describe('replay', () => {
  const batch = (cursor: number): Batch => ({
    id: `b_${cursor}`,
    cursor,
    at,
    actor: 'planner',
    source: 'ops',
    summary: `Step ${cursor}`,
    nodeIds: [],
    edgeIds: [],
  });
  const board = (cursor: number) => ({ id: `board@${cursor}` }) as unknown as Board;

  function setup(count = 5) {
    const { clock, advance } = fakeClock();
    const resolvers = new Map<number, Array<(b: Board) => void>>();
    const signals: Array<{ cursor: number; signal: AbortSignal }> = [];
    const fetchSnapshot = vi.fn(
      (cursor: number, signal: AbortSignal) =>
        new Promise<Board>((resolve, reject) => {
          signals.push({ cursor, signal });
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
          resolvers.set(cursor, [...(resolvers.get(cursor) ?? []), resolve]);
        }),
    );
    const answer = async (cursor: number) => {
      for (const r of resolvers.get(cursor) ?? []) r(board(cursor));
      resolvers.delete(cursor);
      await flush();
    };
    const replay = new ReplayController({
      loadTimeline: async () => ({
        batches: Array.from({ length: count }, (_, i) => batch((i + 1) * 10)).reverse(),
        earliest: 0,
      }),
      fetchSnapshot,
      clock,
      stepMs: 1000,
    });
    return { replay, fetchSnapshot, answer, advance, signals };
  }

  it('opens at the newest batch, steps within bounds, and caches what it fetched', async () => {
    const { replay, fetchSnapshot, answer } = setup();
    await replay.open();
    expect(replay.get()).toMatchObject({ status: 'ready', index: 4, fetching: true });
    await answer(50);
    expect(replay.get()).toMatchObject({ shownIndex: 4, fetching: false });
    expect(replay.get().snapshot).toEqual(board(50));
    replay.step(1);
    expect(replay.get().index).toBe(4);
    replay.home();
    await answer(10);
    expect(replay.get().shownIndex).toBe(0);
    replay.step(-1);
    expect(replay.get().index).toBe(0);
    replay.end();
    expect(replay.get().snapshot).toEqual(board(50));
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('cancels a request the person scrubbed past, and ignores its answer', async () => {
    const { replay, answer, signals } = setup();
    await replay.open(0);
    replay.go(1);
    replay.go(2);
    expect(signals.find((s) => s.cursor === 10)?.signal.aborted).toBe(true);
    expect(signals.find((s) => s.cursor === 20)?.signal.aborted).toBe(true);
    await answer(30);
    expect(replay.get()).toMatchObject({ index: 2, shownIndex: 2 });
    expect(replay.get().snapshot).toEqual(board(30));
  });

  it('plays forward at its pace, fetching the next step ahead, and stops at the end', async () => {
    const { replay, answer, advance, fetchSnapshot } = setup(3);
    await replay.open(0);
    await answer(10);
    replay.setSpeed(2);
    replay.play();
    expect(replay.get().playing).toBe(true);
    // The next step is fetched while this one shows.
    await flush();
    expect(fetchSnapshot.mock.calls.map((c) => c[0])).toContain(20);
    await answer(20);
    await advance(500);
    expect(replay.get().index).toBe(1);
    await answer(30);
    await advance(500);
    expect(replay.get().index).toBe(2);
    await advance(500);
    expect(replay.get().playing).toBe(false);
    replay.play();
    // Playing from the end starts over.
    expect(replay.get().index).toBe(0);
    replay.pause();
    replay.close();
    expect(replay.get().status).toBe('off');
  });

  it('grows the timeline with batches that land meanwhile, without moving the position', async () => {
    const { replay, answer } = setup(3);
    await replay.open(1);
    await answer(20);
    replay.append([batch(30), batch(40), batch(50)]);
    expect(replay.get().ticks.map((b) => b.cursor)).toEqual([10, 20, 30, 40, 50]);
    expect(replay.get()).toMatchObject({ index: 1, shownIndex: 1 });
  });

  it('pages the history back to the earliest point it can rebuild', async () => {
    const pages = [
      { batches: [batch(50), batch(40)], earliest: 15 },
      { batches: [batch(30), batch(20)], earliest: 15 },
      { batches: [batch(10)], earliest: 15 },
    ];
    const page = vi.fn(async () => pages.shift() ?? { batches: [], earliest: 15 });
    const timeline = await loadReplayTimeline(page, 100, 2);
    expect(timeline.batches.map((b) => b.cursor)).toEqual([20, 30, 40, 50]);
    expect(page).toHaveBeenCalledTimes(3);
  });
});
