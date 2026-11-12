/** Small lookups over a whole `Board`, shared by checks, the person and the reference. */
import type { Board, BoardEdge, BoardNode } from '@openboard/core';
import type { NodeRef } from './types.js';

/** A title to match: exact text (case-insensitive, trimmed) or a pattern. */
export type TitleMatch = string | RegExp;

export function titleMatches(title: string, match: TitleMatch): boolean {
  if (typeof match === 'string') return title.trim().toLowerCase() === match.trim().toLowerCase();
  return match.test(title);
}

export function nodes(board: Board): BoardNode[] {
  return Object.values(board.nodes);
}

export function edges(board: Board): BoardEdge[] {
  return Object.values(board.edges);
}

export function findNodes(
  board: Board,
  match: TitleMatch,
  filter: { type?: string; parent?: string | null } = {},
): BoardNode[] {
  return nodes(board).filter(
    (node) =>
      titleMatches(node.title, match) &&
      (filter.type === undefined || node.type === filter.type) &&
      (filter.parent === undefined || (node.parent ?? null) === filter.parent),
  );
}

export function findNode(
  board: Board,
  match: TitleMatch,
  filter: { type?: string; parent?: string | null } = {},
): BoardNode | undefined {
  return findNodes(board, match, filter)[0];
}

/** Nodes with a `file` or `symbol` link to `target` (a project-relative path). */
export function nodesLinkedTo(board: Board, target: string): BoardNode[] {
  return nodes(board).filter((node) =>
    (node.links ?? []).some(
      (link) =>
        (link.kind === 'file' || link.kind === 'symbol') &&
        link.target.replace(/^\.\//, '').split('#')[0] === target,
    ),
  );
}

/** Every frame that contains `node`, nearest first. */
export function ancestors(board: Board, node: BoardNode): BoardNode[] {
  const chain: BoardNode[] = [];
  let parent = node.parent;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const frame = board.nodes[parent];
    if (!frame) break;
    chain.push(frame);
    parent = frame.parent;
  }
  return chain;
}

export function isInside(board: Board, node: BoardNode, frameId: string): boolean {
  return ancestors(board, node).some((frame) => frame.id === frameId);
}

export function edgeBetween(
  board: Board,
  source: string,
  target: string,
  type?: string,
): BoardEdge | undefined {
  return edges(board).find(
    (edge) =>
      edge.source === source &&
      edge.target === target &&
      (type === undefined || edge.type === type),
  );
}

/** The id a reference names, or undefined. */
export function resolveRef(
  board: Board,
  ids: Record<string, string>,
  ref: NodeRef,
): string | undefined {
  if ('id' in ref) return board.nodes[ref.id] ? ref.id : undefined;
  if ('key' in ref) return ids[ref.key];
  return findNode(board, ref.title)?.id;
}

/** What a node means, without bookkeeping and presentation: equal when nobody changed it. */
export function semantic(node: BoardNode): string {
  const { view: _view, updatedAt: _at, updatedBy: _by, links, ...rest } = node;
  const plainLinks = (links ?? []).map(({ hash: _hash, stale: _stale, ...link }) => link);
  return JSON.stringify({ ...rest, links: plainLinks });
}

/** The ids in an `add_node`/`update_node`/... op that it changes, removes or re-parents. */
export function touchedIds(op: Record<string, unknown>): string[] {
  const ids: string[] = [];
  if (typeof op.id === 'string') ids.push(op.id);
  const edge = op.edge as { source?: unknown; target?: unknown } | undefined;
  if (op.op === 'add_edge' && edge) {
    if (typeof edge.source === 'string') ids.push(edge.source);
    if (typeof edge.target === 'string') ids.push(edge.target);
  }
  return ids;
}
