/**
 * Proposals as the canvas and the review panel see them. Pure functions over
 * the proposals in the document and lookups into the board, so they are
 * tested without a canvas.
 *
 *   deriveReview    pending proposals (newest first), the ghost layer, and
 *                   marks on existing nodes and edges a proposal would
 *                   change or remove
 *   fieldChanges    before -> after for one node, for the hover card
 *   toggleItem      checking and unchecking items so dependencies hold, the
 *                   same way the server expands a decision
 *   affectedNodes   which nodes an item is about, to point at them
 */
import type { BoardEdge, BoardNode, Json, Proposal, ProposalItem, View } from '@openboard/core';
import { absoluteRect, type PlacementMap, type Rect } from './geometry.js';

export type MarkKind = 'update' | 'remove' | 'conflict';

/** What pending proposals would do to one existing node or edge. */
export interface ReviewMark {
  kind: MarkKind;
  /** Proposals that touch it, newest first. */
  proposalIds: readonly string[];
  /** For updates: the fields that would change. */
  fields: readonly string[];
  /** For conflicts: why the change can no longer be applied. */
  reason?: string;
}

/** One proposal's footprint on the canvas. */
export interface ProposalGroup {
  proposalId: string;
  author: string;
  /** Ghost nodes it adds. */
  ghostNodeIds: readonly string[];
  /** Existing nodes it changes or removes (and endpoints of edges it touches). */
  touchedNodeIds: readonly string[];
}

export interface ReviewModel {
  /** Pending proposals, newest first. */
  pending: readonly Proposal[];
  /** Decided or withdrawn proposals, most recently decided first. */
  decided: readonly Proposal[];
  ghostNodes: readonly BoardNode[];
  ghostEdges: readonly BoardEdge[];
  /** Ghost node or edge id -> the proposal that adds it. */
  ghostOwner: ReadonlyMap<string, string>;
  nodeMarks: ReadonlyMap<string, ReviewMark>;
  edgeMarks: ReadonlyMap<string, ReviewMark>;
  groups: readonly ProposalGroup[];
  /**
   * Where existing nodes would end up if a pending proposal were accepted
   * (frames that grow, siblings pushed aside). Drawn as outlines only; the
   * real nodes stay where they are until the proposal lands.
   */
  futureViews: ReadonlyMap<string, FutureView>;
}

export interface FutureView {
  view: View;
  proposalId: string;
}

export interface ReviewLookup {
  node(id: string): BoardNode | undefined;
  edge(id: string): BoardEdge | undefined;
}

export const EMPTY_REVIEW: ReviewModel = Object.freeze({
  pending: [],
  decided: [],
  ghostNodes: [],
  ghostEdges: [],
  ghostOwner: new Map(),
  nodeMarks: new Map(),
  edgeMarks: new Map(),
  groups: [],
  futureViews: new Map(),
});

const MARK_RANK: Record<MarkKind, number> = { conflict: 0, update: 1, remove: 2 };

function newestFirst(a: Proposal, b: Proposal): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

function decidedFirst(a: Proposal, b: Proposal): number {
  return (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt);
}

/** Existing node or edge an item changes or removes, if any. */
function itemTarget(item: ProposalItem): { kind: 'node' | 'edge'; id: string } | null {
  const op = item.op;
  switch (op.op) {
    case 'update_node':
    case 'remove_node':
    case 'move_node':
      return { kind: 'node', id: op.id };
    case 'update_edge':
    case 'remove_edge':
      return { kind: 'edge', id: op.id };
    default:
      return null;
  }
}

export function deriveReview(proposals: readonly Proposal[], board: ReviewLookup): ReviewModel {
  const pending = proposals.filter((p) => p.status === 'pending').sort(newestFirst);
  const decided = proposals.filter((p) => p.status !== 'pending').sort(decidedFirst);
  if (pending.length === 0) return { ...EMPTY_REVIEW, decided };

  const ghostNodes: BoardNode[] = [];
  const ghostEdges: BoardEdge[] = [];
  const ghostOwner = new Map<string, string>();
  const nodeMarks = new Map<string, ReviewMark>();
  const edgeMarks = new Map<string, ReviewMark>();
  const groups: ProposalGroup[] = [];
  const futureViews = new Map<string, FutureView>();

  const mark = (
    map: Map<string, ReviewMark>,
    id: string,
    kind: MarkKind,
    proposalId: string,
    fields: readonly string[] = [],
    reason?: string,
  ) => {
    const existing = map.get(id);
    if (!existing) {
      const next: ReviewMark = { kind, proposalIds: [proposalId], fields: [...fields] };
      if (reason !== undefined) next.reason = reason;
      map.set(id, next);
      return;
    }
    const proposalIds = existing.proposalIds.includes(proposalId)
      ? existing.proposalIds
      : [...existing.proposalIds, proposalId];
    const stronger = MARK_RANK[kind] > MARK_RANK[existing.kind];
    const next: ReviewMark = {
      kind: stronger ? kind : existing.kind,
      proposalIds,
      fields: [...new Set([...existing.fields, ...fields])],
    };
    const keptReason = stronger ? reason : (existing.reason ?? reason);
    if (keptReason !== undefined) next.reason = keptReason;
    map.set(id, next);
  };

  // Ids that a ghost may sit inside: real frames, and frames other ghosts add.
  const addedIds = new Set<string>();
  for (const proposal of pending)
    for (const id of Object.keys(proposal.preview.nodes)) addedIds.add(id);

  for (const proposal of pending) {
    const { preview } = proposal;
    const ghostIds: string[] = [];
    const touched = new Set<string>();

    for (const [id, node] of Object.entries(preview.nodes)) {
      if (board.node(id) || ghostOwner.has(id)) continue;
      let ghost = node;
      // A ghost inside a frame that is gone (removed meanwhile) is drawn at the top level.
      if (node.parent !== undefined && !board.node(node.parent) && !addedIds.has(node.parent)) {
        const { parent: _gone, ...rest } = node;
        ghost = rest;
      }
      ghostNodes.push(ghost);
      ghostOwner.set(id, proposal.id);
      ghostIds.push(id);
    }
    for (const [id, edge] of Object.entries(preview.edges)) {
      if (board.edge(id) || ghostOwner.has(id)) continue;
      ghostEdges.push(edge);
      ghostOwner.set(id, proposal.id);
      for (const end of [edge.source, edge.target]) if (board.node(end)) touched.add(end);
    }
    for (const [id, { fields }] of Object.entries(preview.updated)) {
      if (board.node(id)) {
        mark(nodeMarks, id, 'update', proposal.id, fields);
        touched.add(id);
      } else {
        const edge = board.edge(id);
        if (edge) {
          mark(edgeMarks, id, 'update', proposal.id, fields);
          touched.add(edge.source);
          touched.add(edge.target);
        }
      }
    }
    for (const id of preview.removedNodes) {
      if (!board.node(id)) continue;
      mark(nodeMarks, id, 'remove', proposal.id);
      touched.add(id);
    }
    for (const id of preview.removedEdges) {
      const edge = board.edge(id);
      if (!edge) continue;
      mark(edgeMarks, id, 'remove', proposal.id);
      touched.add(edge.source);
      touched.add(edge.target);
    }
    // Items that can no longer apply still say which card they were about.
    for (const item of proposal.items) {
      if (item.status !== 'conflict') continue;
      const target = itemTarget(item);
      if (target?.kind !== 'node' || !board.node(target.id)) continue;
      mark(nodeMarks, target.id, 'conflict', proposal.id, [], item.conflict);
      touched.add(target.id);
    }

    // Newest proposal first: the view it predicts is the one shown.
    for (const [id, view] of Object.entries(proposal.preview.views ?? {})) {
      if (!board.node(id) || futureViews.has(id)) continue;
      futureViews.set(id, { view, proposalId: proposal.id });
      touched.add(id);
    }

    groups.push({
      proposalId: proposal.id,
      author: proposal.author,
      ghostNodeIds: ghostIds,
      touchedNodeIds: [...touched],
    });
  }

  return {
    pending,
    decided,
    ghostNodes,
    ghostEdges,
    ghostOwner,
    nodeMarks,
    edgeMarks,
    groups,
    futureViews,
  };
}

// ── Before and after ─────────────────────────────────────────────────────────

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

const FIELD_NAMES: Record<string, string> = {
  title: 'Title',
  body: 'Description',
  status: 'Status',
  tags: 'Tags',
  type: 'Type',
  parent: 'Frame',
  props: 'Properties',
  links: 'Links',
  label: 'Label',
  view: 'Position',
};

export function fieldName(field: string): string {
  return FIELD_NAMES[field] ?? field;
}

const MAX_VALUE = 60;

/** A short, single-line rendering of a field value. */
export function formatValue(
  field: string,
  value: unknown,
  titleOf?: (id: string) => string,
): string {
  if (value === undefined || value === null || value === '') return 'none';
  if (field === 'parent' && typeof value === 'string') return titleOf?.(value) ?? value;
  if (field === 'status' && typeof value === 'string') return value.replace(/_/g, ' ');
  if (Array.isArray(value)) {
    if (field === 'links') return `${value.length} link${value.length === 1 ? '' : 's'}`;
    return value.length === 0 ? 'none' : clip(value.map((v) => String(v)).join(', '));
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length === 0 ? 'none' : clip(keys.join(', '));
  }
  return clip(String(value).replace(/\s+/g, ' ').trim());
}

function clip(text: string): string {
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

/**
 * What a proposal would change on an existing node: each changed field with
 * its current value and the proposed one. Several pending updates to the same
 * node are applied in batch order.
 */
export function fieldChanges(
  node: BoardNode,
  proposal: Proposal,
  titleOf?: (id: string) => string,
): FieldChange[] {
  const after: Record<string, Json | null> = {};
  for (const item of proposal.items) {
    if (item.status !== 'pending' || item.op.op !== 'update_node' || item.op.id !== node.id)
      continue;
    for (const [field, value] of Object.entries(item.op.patch)) {
      if (value !== undefined) after[field] = value as Json | null;
    }
  }
  // In the order the agent wrote them; the preview says which still change anything.
  const changing = proposal.preview.updated[node.id]?.fields;
  const record = node as unknown as Record<string, unknown>;
  return Object.keys(after)
    .filter((field) => !changing || changing.includes(field))
    .map((field) => ({
      field,
      before: formatValue(field, record[field], titleOf),
      after: after[field] === null ? 'cleared' : formatValue(field, after[field], titleOf),
    }));
}

// ── Choosing items ───────────────────────────────────────────────────────────

/** Items a person can still choose: pending ones. Conflicts and decided items cannot be. */
export function selectable(item: ProposalItem): boolean {
  return item.status === 'pending';
}

/** What starts checked: every pending item. */
export function initialSelection(proposal: Proposal): ReadonlySet<number> {
  return new Set(proposal.items.filter(selectable).map((item) => item.index));
}

/**
 * Check or uncheck one item and keep the selection consistent: checking an
 * item checks what it depends on; unchecking one unchecks what depends on it.
 * Items that are not pending never enter the selection.
 */
export function toggleItem(
  items: readonly ProposalItem[],
  selected: ReadonlySet<number>,
  index: number,
  checked: boolean,
): Set<number> {
  const byIndex = new Map(items.map((item) => [item.index, item]));
  const next = new Set(selected);
  const start = byIndex.get(index);
  if (!start || !selectable(start)) return next;
  const queue = [index];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const current = queue.pop() as number;
    if (seen.has(current)) continue;
    seen.add(current);
    const item = byIndex.get(current);
    if (!item || !selectable(item)) continue;
    if (checked) {
      next.add(current);
      queue.push(...item.dependsOn);
    } else {
      next.delete(current);
      for (const other of items) if (other.dependsOn.includes(current)) queue.push(other.index);
    }
  }
  return next;
}

/** Nodes an item is about (to highlight or pan to). Edges point at both ends. */
export function affectedNodes(
  item: ProposalItem,
  proposal: Proposal,
  board: ReviewLookup,
): string[] {
  const op = item.op;
  switch (op.op) {
    case 'add_node':
      return op.id ? [op.id] : [];
    case 'update_node':
    case 'remove_node':
    case 'move_node':
      return [op.id];
    case 'add_edge':
      return [op.edge.source, op.edge.target];
    case 'update_edge':
    case 'remove_edge': {
      const edge = board.edge(op.id) ?? proposal.preview.edges[op.id];
      return edge ? [edge.source, edge.target] : [];
    }
  }
}

// ── Outcomes ─────────────────────────────────────────────────────────────────

export interface DecisionOutcome {
  accepted: number;
  rejected: number;
  /** Items that could not be applied, with why. */
  conflicts: Array<{ summary: string; reason: string }>;
  /** One or two sentences for the person who decided. */
  text: string;
}

const count = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

/** What a decision did, from the proposal before and after it. */
export function decisionOutcome(before: Proposal, after: Proposal): DecisionOutcome {
  const was = new Map(before.items.map((item) => [item.index, item.status]));
  let accepted = 0;
  let rejected = 0;
  const conflicts: DecisionOutcome['conflicts'] = [];
  for (const item of after.items) {
    if (was.get(item.index) === item.status) continue;
    if (item.status === 'accepted') accepted++;
    else if (item.status === 'rejected') rejected++;
    else if (item.status === 'conflict')
      conflicts.push({ summary: item.summary, reason: item.conflict ?? 'it no longer applies' });
  }
  const parts: string[] = [];
  if (accepted) parts.push(`Accepted ${count(accepted)}`);
  if (rejected) parts.push(`${accepted ? 'rejected' : 'Rejected'} ${count(rejected)}`);
  let text = parts.length ? `${parts.join(', ')}.` : 'Nothing changed.';
  if (conflicts.length)
    text += ` ${count(conflicts.length)} could not be applied because the board changed.`;
  return { accepted, rejected, conflicts, text: text.replace(/^Nothing changed\. /, '') };
}

// ── Future layout ────────────────────────────────────────────────────────────

/** The placements as they would be with the predicted views applied (a new map; `map` is untouched). */
export function withFutureViews(
  map: PlacementMap,
  views: ReadonlyMap<string, FutureView>,
): PlacementMap {
  if (views.size === 0) return map;
  const out = new Map(map);
  for (const [id, { view }] of views) {
    const current = out.get(id);
    if (!current) continue;
    out.set(id, {
      ...current,
      x: view.x,
      y: view.y,
      w: view.w ?? current.w,
      h: view.h ?? current.h,
    });
  }
  return out;
}

export interface FutureOutline {
  id: string;
  proposalId: string;
  frame: boolean;
  /** Canvas rect now and after the proposal, both absolute. */
  now: Rect;
  next: Rect;
}

/** Existing nodes whose rect would change, with their current and future absolute rects. */
export function futureOutlines(
  map: PlacementMap,
  views: ReadonlyMap<string, FutureView>,
): FutureOutline[] {
  if (views.size === 0) return [];
  const future = withFutureViews(map, views);
  const out: FutureOutline[] = [];
  for (const [id, { proposalId }] of views) {
    const now = absoluteRect(id, map);
    const next = absoluteRect(id, future);
    if (!now || !next) continue;
    if (now.x === next.x && now.y === next.y && now.w === next.w && now.h === next.h) continue;
    out.push({ id, proposalId, frame: map.get(id)?.frame ?? false, now, next });
  }
  return out;
}
