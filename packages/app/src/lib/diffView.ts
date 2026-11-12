/**
 * Comparing the board with a git revision: what the canvas marks on the
 * current board (added, updated, moved), the removed nodes and edges drawn as
 * ghosts where they were, counts for the legend, and the list of changes.
 * Pure, from core's `BoardDiff` and the board before and after.
 */
import type { Board, BoardDiff, BoardEdge, BoardNode } from '@openboard/core';
import { fieldName, formatValue } from './review.js';

export type DiffKind = 'added' | 'updated' | 'moved' | 'removed';

/** Fields that change with every edit and say nothing to a person. */
const QUIET_FIELDS: ReadonlySet<string> = new Set([
  'updatedAt',
  'updatedBy',
  'createdAt',
  'createdBy',
  'id',
]);

export interface DiffChange {
  field: string;
  name: string;
  before: string;
  after: string;
}

export interface DiffMark {
  kind: Exclude<DiffKind, 'removed'>;
  /** For updates: what changed, by name. */
  fields: string[];
  /** Short scalars before and after, for the hover card. */
  changes: DiffChange[];
  /** Also moved (an update that moved too). */
  moved: boolean;
}

export interface DiffEntry {
  kind: DiffKind;
  id: string;
  title: string;
  /** For edges: the ids of both ends, to point at. */
  nodeIds: string[];
}

export interface DiffView {
  marks: ReadonlyMap<string, DiffMark>;
  edgeMarks: ReadonlyMap<string, 'added' | 'updated'>;
  /** Removed nodes as they were, placed where they were (in frames that still exist, or ghost frames). */
  ghostNodes: BoardNode[];
  ghostEdges: BoardEdge[];
  removed: ReadonlySet<string>;
  counts: Record<DiffKind, number>;
  /** Grouped by kind, then title. */
  entries: DiffEntry[];
  /** Every node the diff touches, ghosts included; the rest dims with "only changes". */
  touched: ReadonlySet<string>;
}

function title(node: BoardNode | undefined, id: string): string {
  return node?.title ?? id;
}

function changesOf(before: BoardNode, after: BoardNode, fields: readonly string[]): DiffChange[] {
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  return fields
    .filter((f) => !QUIET_FIELDS.has(f))
    .map((field) => ({
      field,
      name: fieldName(field),
      before: formatValue(field, b[field]),
      after: formatValue(field, a[field]),
    }));
}

/**
 * Where a removed node is drawn: as it was, in the frame it was in when that
 * frame is still on the board (or is itself drawn as a ghost); otherwise at
 * its old position on the canvas, so it never lands in a stranger's frame.
 */
function placeRemoved(
  node: BoardNode,
  before: Board,
  after: Board,
  removed: ReadonlySet<string>,
): BoardNode {
  const parent = node.parent;
  if (parent === undefined) return node;
  if (after.nodes[parent]?.type === 'frame' || removed.has(parent)) return node;
  // Climb the old frames to an absolute position.
  let x = node.view?.x ?? 0;
  let y = node.view?.y ?? 0;
  let at: string | undefined = parent;
  const seen = new Set<string>();
  while (at !== undefined && !seen.has(at)) {
    seen.add(at);
    const frame: BoardNode | undefined = before.nodes[at];
    if (!frame) break;
    x += frame.view?.x ?? 0;
    y += frame.view?.y ?? 0;
    at = frame.parent;
  }
  const { parent: _gone, ...rest } = node;
  return { ...rest, view: { ...(node.view ?? {}), x, y } };
}

const ORDER: Record<DiffKind, number> = { added: 0, updated: 1, moved: 2, removed: 3 };

export function deriveDiffView(diff: BoardDiff, before: Board, after: Board): DiffView {
  const marks = new Map<string, DiffMark>();
  const entries: DiffEntry[] = [];
  const touched = new Set<string>();

  for (const node of diff.nodes.added) {
    if (!after.nodes[node.id]) continue;
    marks.set(node.id, { kind: 'added', fields: [], changes: [], moved: false });
    entries.push({ kind: 'added', id: node.id, title: node.title, nodeIds: [node.id] });
    touched.add(node.id);
  }
  for (const update of diff.nodes.updated) {
    if (!after.nodes[update.id]) continue;
    const changes = changesOf(update.before, update.after, update.fields);
    if (changes.length === 0) continue;
    marks.set(update.id, {
      kind: 'updated',
      fields: changes.map((c) => c.name),
      changes,
      moved: false,
    });
    entries.push({
      kind: 'updated',
      id: update.id,
      title: update.after.title,
      nodeIds: [update.id],
    });
    touched.add(update.id);
  }
  let moved = 0;
  for (const move of diff.nodes.moved) {
    if (!after.nodes[move.id]) continue;
    const existing = marks.get(move.id);
    if (existing) {
      existing.moved = true;
      continue;
    }
    moved++;
    marks.set(move.id, { kind: 'moved', fields: [], changes: [], moved: true });
    entries.push({
      kind: 'moved',
      id: move.id,
      title: title(after.nodes[move.id], move.id),
      nodeIds: [move.id],
    });
    touched.add(move.id);
  }

  const removed = new Set(diff.nodes.removed.map((n) => n.id));
  const ghostNodes = diff.nodes.removed.map((n) => placeRemoved(n, before, after, removed));
  for (const node of diff.nodes.removed) {
    entries.push({ kind: 'removed', id: node.id, title: node.title, nodeIds: [node.id] });
    touched.add(node.id);
  }

  const exists = (id: string) => Boolean(after.nodes[id]) || removed.has(id);
  const ghostEdges = diff.edges.removed.filter((e) => exists(e.source) && exists(e.target));
  const edgeMarks = new Map<string, 'added' | 'updated'>();
  for (const edge of diff.edges.added) if (after.edges[edge.id]) edgeMarks.set(edge.id, 'added');
  for (const update of diff.edges.updated) {
    if (!after.edges[update.id]) continue;
    if (update.fields.some((f) => !QUIET_FIELDS.has(f))) edgeMarks.set(update.id, 'updated');
  }
  for (const edge of [...diff.edges.added, ...diff.edges.removed]) {
    touched.add(edge.source);
    touched.add(edge.target);
  }

  const counts: Record<DiffKind, number> = {
    added: diff.nodes.added.length,
    updated: entries.filter((e) => e.kind === 'updated').length,
    moved,
    removed: diff.nodes.removed.length,
  };
  entries.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.title.localeCompare(b.title));
  return { marks, edgeMarks, ghostNodes, ghostEdges, removed, counts, entries, touched };
}

/** "3 added, 1 updated, 2 removed", or "No changes". */
export function diffSummary(counts: Record<DiffKind, number>): string {
  const parts = (['added', 'updated', 'moved', 'removed'] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${k}`);
  return parts.length ? parts.join(', ') : 'No changes';
}
