import { type Board, FRAME_PADDING, GRID, NODE_WIDTH } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import {
  board,
  containmentProblems,
  edge,
  extent,
  frame,
  node,
  randomDag,
  unplaced,
} from './fixtures.js';
import { absoluteRect, applyLayoutPatch, findOverlaps, layoutFull } from './index.js';

async function full(b: Board, opts?: Parameters<typeof layoutFull>[1]): Promise<Board> {
  return applyLayoutPatch(b, await layoutFull(b, opts));
}

const ids = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`);

function chain(): Board {
  const n = ids('c', 6);
  return board(
    n.map((id) => node(id)),
    n.slice(1).map((id, i) => edge(n[i] ?? '', id)),
  );
}

function tree(): Board {
  const nodes = ids('t', 15).map((id) => node(id));
  const edges = ids('t', 15)
    .slice(1)
    .map((id, i) => edge(`t${Math.floor(i / 2)}`, id));
  return board(nodes, edges);
}

function dagWithCrossEdges(): Board {
  const nodes = ids('d', 10).map((id, i) => node(id, i % 2 ? { body: 'details' } : {}));
  const pairs: Array<[number, number]> = [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 3],
    [3, 4],
    [1, 5],
    [5, 6],
    [2, 7],
    [7, 8],
    [8, 9],
    [0, 9],
    [4, 9],
  ];
  return board(
    nodes,
    pairs.map(([a, b]) => edge(`d${a}`, `d${b}`, a % 2 ? 'depends_on' : 'flows_to')),
  );
}

function components(): Board {
  const nodes: ReturnType<typeof node>[] = [];
  const edges: ReturnType<typeof edge>[] = [];
  for (let c = 0; c < 8; c++) {
    nodes.push(node(`k${c}a`), node(`k${c}b`));
    edges.push(edge(`k${c}a`, `k${c}b`));
  }
  for (const id of ids('iso', 20)) nodes.push(node(id));
  return board(nodes, edges);
}

function cycle(): Board {
  return board(
    ['a', 'b', 'c', 'd'].map((id) => node(id)),
    [edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('c', 'd'), edge('d', 'b', 'blocks')],
  );
}

/** Four levels of frames, each holding a few notes and the next frame. */
function nested(): Board {
  const nodes = [frame('f1'), frame('f2', { parent: 'f1' }), frame('f3', { parent: 'f2' })];
  nodes.push(frame('f4', { parent: 'f3' }));
  for (const f of ['f1', 'f2', 'f3', 'f4']) {
    for (const i of [1, 2, 3]) nodes.push(node(`${f}n${i}`, { parent: f }));
  }
  nodes.push(node('top'));
  const edges = [edge('f1n1', 'f1n2'), edge('f4n1', 'f4n2'), edge('f3n1', 'f4'), edge('top', 'f1')];
  return board(nodes, edges);
}

function crossFrame(): Board {
  return board(
    [
      frame('fa'),
      frame('fb'),
      frame('fc', { parent: 'fb' }),
      node('a1', { parent: 'fa' }),
      node('a2', { parent: 'fa' }),
      node('b1', { parent: 'fb' }),
      node('c1', { parent: 'fc' }),
      node('loose'),
    ],
    [edge('a1', 'b1'), edge('a2', 'c1'), edge('c1', 'loose'), edge('loose', 'a1', 'relates_to')],
  );
}

describe('layoutFull', () => {
  it('returns an empty patch for an empty board', async () => {
    expect((await layoutFull(board([]))).size).toBe(0);
  });

  it('places a single node at the origin', async () => {
    const patch = await layoutFull(board([node('only')]));
    expect([...patch]).toEqual([['only', { x: 0, y: 0 }]]);
  });

  const cases: Array<[string, () => Board]> = [
    ['a chain', chain],
    ['a tree', tree],
    ['a DAG with cross edges', dagWithCrossEdges],
    ['disconnected components', components],
    ['a cycle', cycle],
    ['nested frames', nested],
    ['cross-frame edges', crossFrame],
  ];
  for (const direction of ['down', 'right'] as const) {
    it.each(cases)(`lays out %s (${direction}) with no overlaps`, async (_name, make) => {
      const out = await full(make(), { direction });
      expect(unplaced(out)).toEqual([]);
      expect(findOverlaps(out)).toEqual([]);
      expect(containmentProblems(out)).toEqual([]);
      for (const n of Object.values(out.nodes)) {
        expect((n.view?.x ?? 0) % GRID).toBe(0);
        expect((n.view?.y ?? 0) % GRID).toBe(0);
      }
    });
  }

  it('packs disconnected components instead of one long row', async () => {
    const b = board(ids('iso', 40).map((id) => node(id)));
    const out = await full(b);
    const box = extent(out, Object.keys(b.nodes));
    expect(box.w).toBeLessThan(15 * NODE_WIDTH);
    expect(box.h).toBeGreaterThan(200);
  });

  it('keeps nested frames inside their parents in absolute terms', async () => {
    const out = await full(nested());
    for (const n of Object.values(out.nodes)) {
      if (!n.parent) continue;
      const child = absoluteRect(out, n.id);
      const parent = absoluteRect(out, n.parent);
      if (!child || !parent) throw new Error('missing rect');
      expect(child.x).toBeGreaterThanOrEqual(parent.x + FRAME_PADDING.left);
      expect(child.y).toBeGreaterThanOrEqual(parent.y + FRAME_PADDING.top);
      expect(child.x + child.w).toBeLessThanOrEqual(parent.x + parent.w - FRAME_PADDING.right);
      expect(child.y + child.h).toBeLessThanOrEqual(parent.y + parent.h - FRAME_PADDING.bottom);
    }
  });

  it('follows the direction option', async () => {
    const down = await full(chain(), { direction: 'down' });
    const right = await full(chain(), { direction: 'right' });
    const all = Object.keys(down.nodes);
    expect(extent(down, all).h).toBeGreaterThan(extent(down, all).w);
    expect(extent(right, all).w).toBeGreaterThan(extent(right, all).h);
    expect(down.nodes.c0?.view?.y).toBeLessThan(down.nodes.c1?.view?.y ?? 0);
    expect(right.nodes.c0?.view?.x).toBeLessThan(right.nodes.c1?.view?.x ?? 0);
  });

  it('puts the target of depends_on and implements upstream', async () => {
    const b = board(
      ['app', 'lib', 'code', 'spec', 'blocker', 'blocked'].map((id) => node(id)),
      [
        edge('app', 'lib', 'depends_on'),
        edge('code', 'spec', 'implements'),
        edge('blocker', 'blocked', 'blocks'),
      ],
    );
    const out = await full(b);
    const y = (id: string): number => out.nodes[id]?.view?.y ?? Number.NaN;
    expect(y('lib')).toBeLessThan(y('app'));
    expect(y('spec')).toBeLessThan(y('code'));
    expect(y('blocker')).toBeLessThan(y('blocked'));
  });

  it('orders frames by the edges between their contents', async () => {
    const out = await full(crossFrame());
    const fa = out.nodes.fa?.view;
    const fb = out.nodes.fb?.view;
    expect(fa && fb && fa.y < fb.y).toBe(true);
  });

  it('is deterministic, whatever order the board lists things in', async () => {
    const b = dagWithCrossEdges();
    const reversed: Board = {
      ...b,
      nodes: Object.fromEntries(Object.entries(b.nodes).reverse()),
      edges: Object.fromEntries(Object.entries(b.edges).reverse()),
    };
    const first = [...(await layoutFull(b))];
    expect([...(await layoutFull(b))]).toEqual(first);
    expect([...(await layoutFull(reversed))]).toEqual(first);
    expect([...(await layoutFull(nested()))]).toEqual([...(await layoutFull(nested()))]);
  });

  it('lays out a 500-node DAG quickly and without overlaps', async () => {
    const b = randomDag(500, 7);
    const started = performance.now();
    const patch = await layoutFull(b);
    const elapsed = performance.now() - started;
    console.info(`500-node full layout: ${elapsed.toFixed(0)} ms`);
    const out = applyLayoutPatch(b, patch);
    expect(unplaced(out)).toEqual([]);
    expect(findOverlaps(out)).toEqual([]);
    expect(elapsed).toBeLessThan(3000);
  });

  describe('scopes', () => {
    function withPins(): Board {
      return board(
        [
          node('p1', { view: { x: 0, y: 0, pinned: true, color: 'red' } }),
          node('p2', { view: { x: 400, y: 160, w: 300, h: 120, pinned: true } }),
          frame('pf', { view: { x: 900, y: 0, w: 400, h: 240, pinned: true } }),
          node('pf1', { parent: 'pf', view: { x: 32, y: 56 } }),
          node('pf2', { parent: 'pf' }),
          node('pf3', { parent: 'pf', view: { x: 40, y: 120, pinned: true } }),
          node('u1', { view: { x: 10, y: 10 } }),
          node('u2'),
          node('u3', { view: { x: 2000, y: 2000, color: 'blue' } }),
        ],
        [edge('u1', 'u2'), edge('u2', 'u3'), edge('p1', 'u1'), edge('pf1', 'pf2')],
      );
    }

    it('unpinned: pinned nodes keep their exact view and are not overlapped', async () => {
      const b = withPins();
      const patch = await layoutFull(b);
      for (const id of ['p1', 'p2', 'pf3']) expect(patch.has(id)).toBe(false);
      const out = applyLayoutPatch(b, patch);
      expect(out.nodes.p1?.view).toEqual(b.nodes.p1?.view);
      expect(out.nodes.pf?.view?.x).toBe(900);
      expect(out.nodes.pf?.view?.y).toBe(0);
      expect(out.nodes.pf?.view?.pinned).toBe(true);
      expect(out.nodes.u3?.view?.color).toBe('blue');
      expect(findOverlaps(out)).toEqual([]);
      expect(containmentProblems(out)).toEqual([]);
    });

    it('all: everything moves and pinned is cleared', async () => {
      const b = withPins();
      const patch = await layoutFull(b, { scope: 'all' });
      expect([...patch.keys()].sort()).toEqual(Object.keys(b.nodes).sort());
      for (const view of patch.values()) expect(view.pinned).toBeUndefined();
      expect(patch.get('p1')?.color).toBe('red');
      const out = applyLayoutPatch(b, patch);
      expect(findOverlaps(out)).toEqual([]);
      expect(containmentProblems(out)).toEqual([]);
    });

    it('frame id: nothing outside the frame changes', async () => {
      const b = board(
        [
          frame('f', { view: { x: 100, y: 100, w: 1200, h: 800 } }),
          frame('g', { parent: 'f', view: { x: 700, y: 400, w: 400, h: 300 } }),
          node('f1', { parent: 'f', view: { x: 600, y: 60 } }),
          node('f2', { parent: 'f', view: { x: 32, y: 500 } }),
          node('g1', { parent: 'g', view: { x: 100, y: 100 } }),
          node('outside', { view: { x: 2000, y: 0 } }),
          node('other', { view: { x: 0, y: 1400 } }),
        ],
        [edge('f1', 'f2'), edge('f2', 'g1'), edge('outside', 'f1')],
      );
      const patch = await layoutFull(b, { scope: 'f' });
      const changed = [...patch.keys()].sort();
      expect(changed.every((id) => ['f', 'g', 'f1', 'f2', 'g1'].includes(id))).toBe(true);
      expect(changed).toContain('f2');
      expect(patch.get('f')?.x ?? 100).toBe(100);
      expect(patch.get('f')?.y ?? 100).toBe(100);
      const out = applyLayoutPatch(b, patch);
      expect(findOverlaps(out)).toEqual([]);
      expect(containmentProblems(out)).toEqual([]);
    });

    it('frame id: rejects an id that is not a frame', async () => {
      await expect(layoutFull(board([node('a')]), { scope: 'a' })).rejects.toThrow(/not a frame/);
    });
  });
});
