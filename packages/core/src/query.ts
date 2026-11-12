/**
 * Selecting nodes from a board, plus the small graph helpers reads need.
 */
import type { ReadQuery } from './api.js';
import type { Board, BoardEdge, BoardNode } from './schema.js';
import { compareStrings } from './util.js';

// ── Graph helpers ────────────────────────────────────────────────────────────

/** Direct children of a frame, in reading order. */
export function childrenOf(board: Board, frameId: string): BoardNode[] {
  return orderNodes(
    board,
    Object.values(board.nodes).filter((node) => node.parent === frameId),
  );
}

/** Every node inside a frame, at any depth, excluding the frame itself. Frames come before their contents. */
export function descendantsOf(board: Board, frameId: string): BoardNode[] {
  const index = childIndex(board);
  const out: BoardNode[] = [];
  const seen = new Set<string>([frameId]);
  const queue = [frameId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const child of index.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return orderNodes(board, out);
}

/** The frames containing a node, nearest first. */
export function ancestorsOf(board: Board, nodeId: string): BoardNode[] {
  const out: BoardNode[] = [];
  const seen = new Set<string>([nodeId]);
  let parent = board.nodes[nodeId]?.parent;
  while (parent !== undefined && !seen.has(parent)) {
    const node = board.nodes[parent];
    if (!node) break;
    out.push(node);
    seen.add(parent);
    parent = node.parent;
  }
  return out;
}

/** Edges that start or end at a node, sorted by id. */
export function edgesOf(board: Board, nodeId: string): BoardEdge[] {
  return Object.values(board.edges)
    .filter((edge) => edge.source === nodeId || edge.target === nodeId)
    .sort((a, b) => compareStrings(a.id, b.id));
}

/**
 * A node's position in canvas coordinates, or undefined when it or one of
 * its frames has no position yet.
 */
export function absolutePosition(
  board: Board,
  nodeId: string,
): { x: number; y: number } | undefined {
  let x = 0;
  let y = 0;
  const seen = new Set<string>();
  let current: string | undefined = nodeId;
  while (current !== undefined) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const node: BoardNode | undefined = board.nodes[current];
    if (!node) break;
    if (!node.view) return undefined;
    x += node.view.x;
    y += node.view.y;
    current = node.parent;
  }
  return { x, y };
}

function childIndex(board: Board): Map<string, BoardNode[]> {
  const index = new Map<string, BoardNode[]>();
  for (const node of Object.values(board.nodes)) {
    if (node.parent === undefined) continue;
    const list = index.get(node.parent);
    if (list) list.push(node);
    else index.set(node.parent, [node]);
  }
  return index;
}

/**
 * Put nodes in the order reads present them: a frame before its contents
 * (depth first), siblings in reading order (top to bottom, then left to
 * right) when they have positions, otherwise by creation time and then id.
 * Nodes with a position come before nodes without one.
 */
export function orderNodes(board: Board, nodes: readonly BoardNode[]): BoardNode[] {
  const set = new Map(nodes.map((node) => [node.id, node]));
  const positions = new Map<string, { x: number; y: number } | undefined>();
  const position = (id: string) => {
    if (!positions.has(id)) positions.set(id, absolutePosition(board, id));
    return positions.get(id);
  };

  const groups = new Map<string | undefined, BoardNode[]>();
  for (const node of set.values()) {
    const key = nearestAncestorIn(board, node, set);
    const group = groups.get(key);
    if (group) group.push(node);
    else groups.set(key, [node]);
  }
  const compare = (a: BoardNode, b: BoardNode) => {
    const pa = position(a.id);
    const pb = position(b.id);
    if (pa && pb) {
      if (pa.y !== pb.y) return pa.y - pb.y;
      if (pa.x !== pb.x) return pa.x - pb.x;
    } else if (pa) return -1;
    else if (pb) return 1;
    return compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id);
  };
  for (const group of groups.values()) group.sort(compare);

  const out: BoardNode[] = [];
  const visit = (key: string | undefined) => {
    for (const node of groups.get(key) ?? []) {
      out.push(node);
      visit(node.id);
    }
  };
  visit(undefined);
  if (out.length < set.size) {
    // Only reachable through a parent cycle, which a valid board never has.
    const placed = new Set(out.map((node) => node.id));
    out.push(...[...set.values()].filter((node) => !placed.has(node.id)).sort(compare));
  }
  return out;
}

/** The closest frame above `node` that is itself in `set`, if any. */
export function nearestAncestorIn(
  board: Board,
  node: BoardNode,
  set: ReadonlyMap<string, unknown> | ReadonlySet<string>,
): string | undefined {
  const seen = new Set<string>([node.id]);
  let parent = node.parent;
  while (parent !== undefined && !seen.has(parent)) {
    if (set.has(parent)) return parent;
    seen.add(parent);
    parent = board.nodes[parent]?.parent;
  }
  return undefined;
}

// ── Selection ────────────────────────────────────────────────────────────────

/**
 * The nodes a read covers, in presentation order (see {@link orderNodes}).
 * Filters combine with AND; `neighbors` then adds nodes within that many edge
 * hops of the matches, in either direction.
 */
export function selectNodes(
  board: Board,
  query: ReadQuery,
  ctx?: { selection?: { nodeIds: string[] } },
): BoardNode[] {
  let matches = Object.values(board.nodes);

  if (query.ids) {
    const ids = new Set(query.ids);
    matches = matches.filter((node) => ids.has(node.id));
  }
  if (query.frame !== undefined) {
    const inside = new Set(descendantsOf(board, query.frame).map((node) => node.id));
    matches = matches.filter((node) => inside.has(node.id));
  }
  if (query.selection) {
    const selected = new Set(ctx?.selection?.nodeIds ?? []);
    matches = matches.filter((node) => selected.has(node.id));
  }
  if (query.types) {
    const types = new Set<string>(query.types);
    matches = matches.filter((node) => types.has(node.type));
  }
  if (query.statuses) {
    const statuses = new Set<string>(query.statuses);
    matches = matches.filter((node) => node.status !== undefined && statuses.has(node.status));
  }
  if (query.tags && query.tags.length > 0) {
    const wanted = query.tags;
    matches = matches.filter((node) => wanted.every((tag) => node.tags?.includes(tag)));
  }
  if (query.text !== undefined && query.text !== '') {
    const needle = query.text.toLowerCase();
    matches = matches.filter(
      (node) =>
        node.title.toLowerCase().includes(needle) ||
        (node.body?.toLowerCase().includes(needle) ?? false),
    );
  }

  const hops = query.neighbors ?? 0;
  if (hops > 0 && matches.length > 0) {
    const adjacency = new Map<string, string[]>();
    const link = (a: string, b: string) => {
      const list = adjacency.get(a);
      if (list) list.push(b);
      else adjacency.set(a, [b]);
    };
    for (const edge of Object.values(board.edges)) {
      link(edge.source, edge.target);
      link(edge.target, edge.source);
    }
    const found = new Set(matches.map((node) => node.id));
    let frontier = [...found];
    for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const other of adjacency.get(id) ?? []) {
          if (found.has(other) || !board.nodes[other]) continue;
          found.add(other);
          next.push(other);
        }
      }
      frontier = next;
    }
    matches = [...found].map((id) => board.nodes[id] as BoardNode);
  }

  return orderNodes(board, matches);
}
