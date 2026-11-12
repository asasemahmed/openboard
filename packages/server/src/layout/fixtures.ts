/**
 * Small builders for hand-made boards, used by the layout tests. Bookkeeping
 * fields get fixed values so boards built twice are identical.
 */
import {
  type Board,
  type BoardEdge,
  type BoardNode,
  FRAME_MIN,
  FRAME_PADDING,
  NODE_GAP,
  type View,
} from '@openboard/core';
import { nodeSize, rectsTooClose } from './geometry.js';

const AT = '2026-01-01T00:00:00.000Z';
const ACTOR = 'tester';

export interface NodeSpec {
  type?: BoardNode['type'];
  title?: string;
  body?: string;
  parent?: string;
  view?: View;
}

export function node(id: string, spec: NodeSpec = {}): BoardNode {
  const out: BoardNode = {
    id,
    type: spec.type ?? 'note',
    title: spec.title ?? `Node ${id}`,
    createdBy: ACTOR,
    createdAt: AT,
    updatedBy: ACTOR,
    updatedAt: AT,
  };
  if (spec.body !== undefined) out.body = spec.body;
  if (spec.parent !== undefined) out.parent = spec.parent;
  if (spec.view !== undefined) out.view = spec.view;
  return out;
}

export function frame(id: string, spec: Omit<NodeSpec, 'type'> = {}): BoardNode {
  return node(id, { ...spec, type: 'frame', title: spec.title ?? `Frame ${id}` });
}

export function edge(
  source: string,
  target: string,
  type: BoardEdge['type'] = 'flows_to',
): BoardEdge {
  return {
    id: `${type}:${source}:${target}`,
    type,
    source,
    target,
    createdBy: ACTOR,
    createdAt: AT,
    updatedBy: ACTOR,
    updatedAt: AT,
  };
}

export function board(nodes: readonly BoardNode[], edges: readonly BoardEdge[] = []): Board {
  return {
    schemaVersion: 1,
    id: 'test-board',
    name: 'Test board',
    createdAt: AT,
    updatedAt: AT,
    actors: { [ACTOR]: { id: ACTOR, kind: 'human', name: 'Tester' } },
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: Object.fromEntries(edges.map((e) => [e.id, e])),
  };
}

/** A deterministic pseudo-random source (linear congruential), for generated fixtures. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** A random DAG of `count` notes where each node links to up to `maxParents` earlier ones. */
export function randomDag(count: number, seed = 1, maxParents = 2): Board {
  const rand = seeded(seed);
  const nodes: BoardNode[] = [];
  const edges = new Map<string, BoardEdge>();
  for (let i = 0; i < count; i++) {
    const id = `n${String(i).padStart(4, '0')}`;
    nodes.push(node(id, i % 3 === 0 ? { body: 'Some details.' } : {}));
    if (i === 0) continue;
    const parents = Math.floor(rand() * (maxParents + 1));
    for (let p = 0; p < parents; p++) {
      const source = `n${String(Math.floor(rand() * i)).padStart(4, '0')}`;
      const e = edge(source, id);
      edges.set(e.id, e);
    }
  }
  return board(nodes, [...edges.values()]);
}

/** Ids of nodes that have no view. */
export function unplaced(b: Board): string[] {
  return Object.values(b.nodes)
    .filter((n) => !n.view)
    .map((n) => n.id)
    .sort();
}

/**
 * Every frame whose children are not inside its padding or that is smaller
 * than `FRAME_MIN`, described in plain words (an empty list means all is well).
 */
export function containmentProblems(b: Board): string[] {
  const problems: string[] = [];
  for (const parent of Object.values(b.nodes)) {
    if (parent.type !== 'frame' || !parent.view) continue;
    const size = nodeSize(parent);
    if (size.w < FRAME_MIN.w || size.h < FRAME_MIN.h)
      problems.push(`${parent.id} is below FRAME_MIN`);
    for (const child of Object.values(b.nodes)) {
      if (child.parent !== parent.id || !child.view) continue;
      const c = nodeSize(child);
      if (
        child.view.x < FRAME_PADDING.left ||
        child.view.y < FRAME_PADDING.top ||
        child.view.x + c.w > size.w - FRAME_PADDING.right ||
        child.view.y + c.h > size.h - FRAME_PADDING.bottom
      ) {
        problems.push(`${child.id} is not inside ${parent.id}`);
      }
    }
  }
  return problems.sort();
}

/** Pairs of siblings closer than `NODE_GAP` on both axes. */
export function gapViolations(b: Board, ids?: readonly string[]): Array<[string, string]> {
  const only = ids ? new Set(ids) : undefined;
  const out: Array<[string, string]> = [];
  const list = Object.values(b.nodes)
    .filter((n) => n.view)
    .sort((p, q) => (p.id < q.id ? -1 : 1));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const p = list[i];
      const q = list[j];
      if (!p?.view || !q?.view || (p.parent ?? '') !== (q.parent ?? '')) continue;
      if (only && !only.has(p.id) && !only.has(q.id)) continue;
      const a = { x: p.view.x, y: p.view.y, ...nodeSize(p) };
      const c = { x: q.view.x, y: q.view.y, ...nodeSize(q) };
      if (rectsTooClose(a, c, NODE_GAP)) out.push([p.id, q.id]);
    }
  }
  return out;
}

/** Bounding box of the given nodes' views (relative coordinates). */
export function extent(b: Board, ids: readonly string[]): { w: number; h: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const id of ids) {
    const n = b.nodes[id];
    if (!n?.view) continue;
    const s = nodeSize(n);
    minX = Math.min(minX, n.view.x);
    minY = Math.min(minY, n.view.y);
    maxX = Math.max(maxX, n.view.x + s.w);
    maxY = Math.max(maxY, n.view.y + s.h);
  }
  return { w: maxX - minX, h: maxY - minY };
}
