/**
 * Structural differences between two versions of a board.
 *
 * Meaning and presentation are reported apart: a node whose only change is its
 * `view` is `moved`, not `updated`. A node that changed both appears in both
 * lists, with `view` left out of its updated `fields`.
 */
import type { Board, BoardEdge, BoardNode, View } from './schema.js';
import { changedFields, compareStrings, jsonEqual } from './util.js';

export interface NodeUpdate {
  id: string;
  /** Changed fields other than `view`, sorted. Includes bookkeeping fields. */
  fields: string[];
  before: BoardNode;
  after: BoardNode;
}

export interface NodeMove {
  id: string;
  before?: View;
  after?: View;
}

export interface EdgeUpdate {
  id: string;
  /** Changed fields, sorted. Includes bookkeeping fields. */
  fields: string[];
  before: BoardEdge;
  after: BoardEdge;
}

export interface BoardDiff {
  /** Changed board-level fields (`name`, `description`, `updatedAt`, ...), sorted. */
  meta: string[];
  /** Actor ids, sorted. */
  actors: { added: string[]; removed: string[]; updated: string[] };
  nodes: { added: BoardNode[]; removed: BoardNode[]; updated: NodeUpdate[]; moved: NodeMove[] };
  edges: { added: BoardEdge[]; removed: BoardEdge[]; updated: EdgeUpdate[] };
  isEmpty: boolean;
}

const META_FIELDS = [
  'schemaVersion',
  'id',
  'name',
  'description',
  'createdAt',
  'updatedAt',
] as const;

/** Everything that differs between `before` and `after`. All lists are sorted by id. */
export function diffBoards(before: Board, after: Board): BoardDiff {
  const meta = META_FIELDS.filter((key) => !jsonEqual(before[key], after[key]));

  const actors = { added: [] as string[], removed: [] as string[], updated: [] as string[] };
  for (const id of unionKeys(before.actors, after.actors)) {
    const a = before.actors[id];
    const b = after.actors[id];
    if (!a && b) actors.added.push(id);
    else if (a && !b) actors.removed.push(id);
    else if (a && b && changedFields(a, b).length) actors.updated.push(id);
  }

  const nodes: BoardDiff['nodes'] = { added: [], removed: [], updated: [], moved: [] };
  for (const id of unionKeys(before.nodes, after.nodes)) {
    const a = before.nodes[id];
    const b = after.nodes[id];
    if (!a && b) nodes.added.push(b);
    else if (a && !b) nodes.removed.push(a);
    else if (a && b) {
      const fields = changedFields(a, b);
      const semantic = fields.filter((field) => field !== 'view');
      if (semantic.length) nodes.updated.push({ id, fields: semantic, before: a, after: b });
      if (semantic.length !== fields.length) {
        nodes.moved.push({
          id,
          ...(a.view ? { before: a.view } : {}),
          ...(b.view ? { after: b.view } : {}),
        });
      }
    }
  }

  const edges: BoardDiff['edges'] = { added: [], removed: [], updated: [] };
  for (const id of unionKeys(before.edges, after.edges)) {
    const a = before.edges[id];
    const b = after.edges[id];
    if (!a && b) edges.added.push(b);
    else if (a && !b) edges.removed.push(a);
    else if (a && b) {
      const fields = changedFields(a, b);
      if (fields.length) edges.updated.push({ id, fields, before: a, after: b });
    }
  }

  const isEmpty =
    meta.length === 0 &&
    actors.added.length + actors.removed.length + actors.updated.length === 0 &&
    nodes.added.length + nodes.removed.length + nodes.updated.length + nodes.moved.length === 0 &&
    edges.added.length + edges.removed.length + edges.updated.length === 0;

  return { meta, actors, nodes, edges, isEmpty };
}

function unionKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(compareStrings);
}
