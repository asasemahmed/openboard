/**
 * The board seen as a tree of containers (the canvas and its frames), with
 * every edge lifted to the container where it can influence placement.
 */
import type { Board, BoardEdge, BoardNode } from '@openboard/core';
import { cmp } from './geometry.js';

/** Container key for the canvas itself. `#` cannot appear in a node id, so it never collides. */
export const ROOT = '#root';

/**
 * Edge types whose target is laid out upstream of (above, or left of) their
 * source. Every other type, including `relates_to` and custom types, puts the
 * source upstream.
 *
 * - `A flows_to B`: A then B.
 * - `A blocks B`: A then B (the blocker comes first).
 * - `A depends_on B`: B then A, so it reads the same as `B blocks A`.
 * - `A implements B`: B then A (the spec or decision sits above its implementation).
 * - `A evidence_for B`: A then B (evidence leads to the claim).
 */
export const UPSTREAM_TARGET_EDGE_TYPES: ReadonlySet<string> = new Set([
  'depends_on',
  'implements',
]);

/** `[upstream, downstream]` for an edge, following the convention above. */
export function orientEdge(edge: Pick<BoardEdge, 'type' | 'source' | 'target'>): [string, string] {
  return UPSTREAM_TARGET_EDGE_TYPES.has(edge.type)
    ? [edge.target, edge.source]
    : [edge.source, edge.target];
}

export interface Structure {
  board: Board;
  /** Node id -> container key (`ROOT` or a frame id). */
  containerOf: Map<string, string>;
  /** Container key -> its direct children, sorted by id. */
  children: Map<string, BoardNode[]>;
  /** Container key -> nesting depth (`ROOT` is 0). */
  depth: Map<string, number>;
  /** Container key -> lifted `[upstream, downstream]` pairs between its children, deduplicated and sorted. */
  flow: Map<string, Array<[string, string]>>;
}

export function buildStructure(board: Board): Structure {
  const ids = Object.keys(board.nodes).sort();
  const containerOf = new Map<string, string>();
  for (const id of ids) {
    const node = board.nodes[id];
    const parent = node?.parent;
    containerOf.set(
      id,
      parent !== undefined && board.nodes[parent]?.type === 'frame' ? parent : ROOT,
    );
  }
  // Cut parent cycles (invalid boards only): a node whose chain leads back to
  // itself is moved to the canvas.
  for (const id of ids) {
    const seen = new Set<string>([id]);
    let current = id;
    for (;;) {
      const up = containerOf.get(current) ?? ROOT;
      if (up === ROOT) break;
      if (seen.has(up)) {
        containerOf.set(current, ROOT);
        break;
      }
      seen.add(up);
      current = up;
    }
  }

  const depth = new Map<string, number>([[ROOT, 0]]);
  const depthOf = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    const d = depthOf(containerOf.get(key) ?? ROOT) + 1;
    depth.set(key, d);
    return d;
  };

  const children = new Map<string, BoardNode[]>([[ROOT, []]]);
  for (const id of ids) {
    const node = board.nodes[id];
    if (!node) continue;
    if (node.type === 'frame') {
      depthOf(id);
      if (!children.has(id)) children.set(id, []);
    }
    const key = containerOf.get(id) ?? ROOT;
    const list = children.get(key);
    if (list) list.push(node);
    else children.set(key, [node]);
  }

  const chainOf = (id: string): string[] => {
    const chain = [id];
    let current = id;
    while (current !== ROOT) {
      current = containerOf.get(current) ?? ROOT;
      chain.push(current);
    }
    return chain;
  };

  const flowKeys = new Map<string, Map<string, [string, string]>>();
  const edgeIds = Object.keys(board.edges).sort();
  for (const edgeId of edgeIds) {
    const edge = board.edges[edgeId];
    if (!edge || edge.source === edge.target) continue;
    if (!board.nodes[edge.source] || !board.nodes[edge.target]) continue;
    const [up, down] = orientEdge(edge);
    const upChain = chainOf(up);
    const downChain = chainOf(down);
    const downIndex = new Map(downChain.map((key, i) => [key, i]));
    // The first container of `up` that also contains `down` is where the edge lives.
    for (let i = 1; i < upChain.length; i++) {
      const container = upChain[i];
      if (container === undefined) break;
      const j = downIndex.get(container);
      if (j === undefined) continue;
      const a = upChain[i - 1];
      const b = downChain[j - 1];
      // `b` is undefined when `down` is this container itself; `a === b` when
      // one endpoint contains the other. Neither says anything about placement.
      if (a !== undefined && b !== undefined && j > 0 && a !== b) {
        let map = flowKeys.get(container);
        if (!map) {
          map = new Map();
          flowKeys.set(container, map);
        }
        map.set(`${a}\u0000${b}`, [a, b]);
      }
      break;
    }
  }
  const flow = new Map<string, Array<[string, string]>>();
  for (const [container, map] of flowKeys) {
    flow.set(
      container,
      [...map.entries()].sort((p, q) => cmp(p[0], q[0])).map(([, pair]) => pair),
    );
  }

  return { board, containerOf, children, depth, flow };
}

/** Frames in `keys` ordered deepest first (ties by id), so children are finished before their parents. */
export function bottomUp(structure: Structure, keys: Iterable<string>): string[] {
  return [...keys].sort((a, b) => {
    const da = structure.depth.get(a) ?? 0;
    const db = structure.depth.get(b) ?? 0;
    return db - da || cmp(a, b);
  });
}

/** Every frame nested inside `frameId`, at any depth, plus `frameId` itself. */
export function frameSubtree(structure: Structure, frameId: string): string[] {
  const out: string[] = [];
  const stack = [frameId];
  while (stack.length > 0) {
    const key = stack.pop();
    if (key === undefined) break;
    out.push(key);
    for (const child of structure.children.get(key) ?? []) {
      if (child.type === 'frame') stack.push(child.id);
    }
  }
  return out;
}
