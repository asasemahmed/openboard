import { type Board, type BoardEdge, type BoardNode, NODE_GAP } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import {
  board,
  containmentProblems,
  edge,
  frame,
  gapViolations,
  node,
  randomDag,
  unplaced,
} from './fixtures.js';
import {
  applyLayoutPatch,
  findOverlaps,
  layoutFull,
  layoutIncremental,
  nodeSize,
  type Rect,
} from './index.js';

/** A board that has been laid out once, as a human would find it. */
async function arranged(nodes: BoardNode[], edges: BoardEdge[] = []): Promise<Board> {
  const b = board(nodes, edges);
  return applyLayoutPatch(b, await layoutFull(b));
}

/** Adds nodes and edges (without views) to an existing board. */
function add(b: Board, nodes: BoardNode[], edges: BoardEdge[] = []): Board {
  return {
    ...b,
    nodes: { ...b.nodes, ...Object.fromEntries(nodes.map((n) => [n.id, n])) },
    edges: { ...b.edges, ...Object.fromEntries(edges.map((e) => [e.id, e])) },
  };
}

function rect(b: Board, id: string): Rect {
  const n = b.nodes[id];
  if (!n?.view) throw new Error(`${id} has no view`);
  return { x: n.view.x, y: n.view.y, ...nodeSize(n) };
}

const centreX = (r: Rect): number => r.x + r.w / 2;
const centreY = (r: Rect): number => r.y + r.h / 2;

function expectHealthy(b: Board, fresh: readonly string[]): void {
  expect(unplaced(b)).toEqual([]);
  expect(findOverlaps(b)).toEqual([]);
  expect(gapViolations(b, fresh)).toEqual([]);
  expect(containmentProblems(b)).toEqual([]);
}

describe('layoutIncremental', () => {
  it('gives a fresh board the same layout as layoutFull', async () => {
    const b = randomDag(60, 3);
    expect([...(await layoutIncremental(b))]).toEqual([...(await layoutFull(b))]);
    const framed = board(
      [frame('f'), node('a', { parent: 'f' }), node('b', { parent: 'f' }), node('c')],
      [edge('a', 'b'), edge('b', 'c')],
    );
    expect([...(await layoutIncremental(framed))]).toEqual([...(await layoutFull(framed))]);
  });

  it('returns an empty patch when everything is placed', async () => {
    const b = await arranged([node('a'), node('b')], [edge('a', 'b')]);
    expect((await layoutIncremental(b)).size).toBe(0);
  });

  it('leaves existing views byte-for-byte unchanged', async () => {
    const base = await arranged(
      [node('a'), node('b'), node('c'), node('d', { view: { x: 900, y: 40, pinned: true } })],
      [edge('a', 'b'), edge('a', 'c')],
    );
    const before = JSON.stringify(base.nodes);
    const b = add(base, [node('x'), node('y')], [edge('b', 'x'), edge('x', 'y', 'blocks')]);
    const patch = await layoutIncremental(b);
    expect([...patch.keys()].sort()).toEqual(['x', 'y']);
    const out = applyLayoutPatch(b, patch);
    const kept = Object.fromEntries(Object.entries(out.nodes).filter(([id]) => base.nodes[id]));
    expect(JSON.stringify(kept)).toBe(before);
    expectHealthy(out, ['x', 'y']);
  });

  it('places a node after its upstream neighbour, close to it', async () => {
    const base = await arranged(
      [node('a'), node('b'), node('c')],
      [edge('a', 'b'), edge('a', 'c')],
    );
    const out = applyLayoutPatch(
      add(base, [node('x')], [edge('b', 'x')]),
      await layoutIncremental(add(base, [node('x')], [edge('b', 'x')])),
    );
    const b = rect(out, 'b');
    const x = rect(out, 'x');
    expect(x.y).toBeGreaterThanOrEqual(b.y + b.h + NODE_GAP.y);
    expect(x.y).toBeLessThanOrEqual(b.y + b.h + 2 * NODE_GAP.y);
    expect(Math.abs(centreX(x) - centreX(b))).toBeLessThan(b.w);
    expectHealthy(out, ['x']);
  });

  it('reads depends_on naturally: the dependency sits above the dependent', async () => {
    const base = await arranged([node('mid')]);
    const b = add(
      base,
      [node('needs'), node('needed')],
      [edge('needs', 'mid', 'depends_on'), edge('mid', 'needed', 'depends_on')],
    );
    const out = applyLayoutPatch(b, await layoutIncremental(b));
    const mid = rect(out, 'mid');
    const needs = rect(out, 'needs');
    const needed = rect(out, 'needed');
    expect(needed.y + needed.h + NODE_GAP.y).toBeLessThanOrEqual(mid.y);
    expect(mid.y - (needed.y + needed.h)).toBeLessThanOrEqual(2 * NODE_GAP.y);
    expect(needs.y).toBeGreaterThanOrEqual(mid.y + mid.h + NODE_GAP.y);
    expect(needs.y - (mid.y + mid.h)).toBeLessThanOrEqual(2 * NODE_GAP.y);
    expectHealthy(out, ['needs', 'needed']);
  });

  it('places to the right when the direction is right', async () => {
    const base = await arranged([node('a'), node('b')], [edge('a', 'b')]);
    const b = add(base, [node('x')], [edge('b', 'x')]);
    const out = applyLayoutPatch(b, await layoutIncremental(b, { direction: 'right' }));
    const anchor = rect(out, 'b');
    const x = rect(out, 'x');
    expect(x.x).toBeGreaterThanOrEqual(anchor.x + anchor.w + NODE_GAP.x);
    expect(x.x - (anchor.x + anchor.w)).toBeLessThanOrEqual(2 * NODE_GAP.x);
    expect(Math.abs(centreY(x) - centreY(anchor))).toBeLessThan(anchor.h + NODE_GAP.y);
  });

  it('fans several new children of one node out in a row', async () => {
    const base = await arranged([node('hub'), node('side')], [edge('side', 'hub', 'relates_to')]);
    const kids = ['k1', 'k2', 'k3'];
    const b = add(
      base,
      kids.map((id) => node(id)),
      kids.map((id) => edge('hub', id)),
    );
    const out = applyLayoutPatch(b, await layoutIncremental(b));
    const hub = rect(out, 'hub');
    const rows = new Set(kids.map((id) => rect(out, id).y));
    expect(rows.size).toBe(1);
    for (const id of kids) expect(rect(out, id).y).toBeGreaterThan(hub.y + hub.h);
    expectHealthy(out, kids);
  });

  it('puts unconnected nodes next to their siblings', async () => {
    const base = await arranged([node('a'), node('b'), node('c')], [edge('a', 'b')]);
    const b = add(base, [node('lone')]);
    const out = applyLayoutPatch(b, await layoutIncremental(b));
    const lone = rect(out, 'lone');
    const right = Math.max(...['a', 'b', 'c'].map((id) => rect(out, id).x + rect(out, id).w));
    expect(lone.x).toBeGreaterThanOrEqual(right + NODE_GAP.x);
    expect(lone.x - right).toBeLessThanOrEqual(2 * NODE_GAP.x);
    expectHealthy(out, ['lone']);
  });

  it('anchors a node to the frame that holds its neighbour', async () => {
    const base = await arranged([frame('f'), node('inner', { parent: 'f' }), node('other')]);
    const b = add(base, [node('x')], [edge('inner', 'x')]);
    const out = applyLayoutPatch(b, await layoutIncremental(b));
    const f = rect(out, 'f');
    const x = rect(out, 'x');
    expect(x.y).toBeGreaterThanOrEqual(f.y + f.h + NODE_GAP.y);
    expect(x.y - (f.y + f.h)).toBeLessThanOrEqual(2 * NODE_GAP.y);
    expectHealthy(out, ['x']);
  });

  it('grows a frame to hold new children, keeping its position', async () => {
    const base = await arranged([frame('f'), node('f1', { parent: 'f' }), node('out')]);
    const before = rect(base, 'f');
    const b = add(
      base,
      [node('f2', { parent: 'f' }), node('f3', { parent: 'f' })],
      [edge('f1', 'f2'), edge('f2', 'f3')],
    );
    const patch = await layoutIncremental(b);
    const out = applyLayoutPatch(b, patch);
    const after = rect(out, 'f');
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(after.h).toBeGreaterThan(before.h);
    expect(patch.has('f1')).toBe(false);
    expectHealthy(out, ['f2', 'f3']);
  });

  it('grows a pinned frame too, without moving it', async () => {
    const b = board([
      frame('f', { view: { x: 40, y: 40, w: 328, h: 200, pinned: true } }),
      node('f1', { parent: 'f', view: { x: 32, y: 56 } }),
      node('f2', { parent: 'f' }),
    ]);
    const out = applyLayoutPatch(b, await layoutIncremental(b));
    expect(out.nodes.f?.view).toMatchObject({ x: 40, y: 40, pinned: true });
    expectHealthy(out, ['f2']);
  });

  it('pushes an unpinned sibling out of a grown frame, but never a pinned one', async () => {
    const b = board([
      frame('f', { view: { x: 0, y: 0, w: 328, h: 200 } }),
      node('f1', { parent: 'f', view: { x: 32, y: 56 } }),
      node('free', { view: { x: 376, y: 0 } }),
      node('fixed', { view: { x: 376, y: 600, pinned: true } }),
    ]);
    const grown = add(b, [node('f2', { parent: 'f' })]);
    const patch = await layoutIncremental(grown);
    const out = applyLayoutPatch(grown, patch);
    expect(rect(out, 'f').w).toBeGreaterThan(328);
    expect(patch.has('fixed')).toBe(false);
    expect(patch.get('free')?.y).toBe(0);
    expect(patch.get('free')?.x).toBeGreaterThanOrEqual(rect(out, 'f').w + NODE_GAP.x);
    expect(findOverlaps(out)).toEqual([]);
    expect(containmentProblems(out)).toEqual([]);
  });

  it('sizes a new frame to its new children', async () => {
    const base = await arranged([node('a'), node('b')], [edge('a', 'b')]);
    const b = add(base, [
      frame('nf'),
      node('n1', { parent: 'nf' }),
      node('n2', { parent: 'nf' }),
      node('n3', { parent: 'nf' }),
    ]);
    const patch = await layoutIncremental(b);
    const out = applyLayoutPatch(b, patch);
    expect(patch.get('nf')?.w).toBeGreaterThan(0);
    expect(patch.get('nf')?.h).toBeGreaterThan(0);
    expectHealthy(out, ['nf', 'n1', 'n2', 'n3']);
  });

  it('lays out a batch of new nodes with ELK around the few that exist', async () => {
    const base = await arranged([node('seed')]);
    const extra = randomDag(30, 5);
    const b = add(base, Object.values(extra.nodes), Object.values(extra.edges));
    const patch = await layoutIncremental(b);
    expect(patch.has('seed')).toBe(false);
    const out = applyLayoutPatch(b, patch);
    expect(unplaced(out)).toEqual([]);
    expect(findOverlaps(out)).toEqual([]);
  });

  it('places a few nodes on a 500-node board quickly', async () => {
    const big = randomDag(500, 11);
    const base = applyLayoutPatch(big, await layoutFull(big));
    const b = add(
      base,
      ['z1', 'z2', 'z3', 'z4', 'z5'].map((id) => node(id)),
      [edge('n0100', 'z1'), edge('n0100', 'z2'), edge('z2', 'z3'), edge('n0499', 'z4')],
    );
    const started = performance.now();
    const patch = await layoutIncremental(b);
    expect(performance.now() - started).toBeLessThan(1000);
    expect([...patch.keys()].sort()).toEqual(['z1', 'z2', 'z3', 'z4', 'z5']);
    expectHealthy(applyLayoutPatch(b, patch), ['z1', 'z2', 'z3', 'z4', 'z5']);
  });
});
