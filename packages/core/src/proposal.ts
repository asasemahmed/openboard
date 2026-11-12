/**
 * Proposals as pure functions: turning a batch that needs review into a
 * `Proposal`, expanding a decision so it respects dependencies between items,
 * and checking which pending items still apply to a board that has moved on.
 */
import { OpenBoardError } from './api.js';
import { type ApplyContext, type ApplyOutcome, applyOps } from './apply.js';
import type {
  Decision,
  OpVerdict,
  Proposal,
  ProposalItem,
  ProposalPreview,
  ProposalStatus,
} from './collab.js';
import { newId as defaultNewId } from './ids.js';
import type { AppliedOps, Op } from './ops.js';
import type { Actor, Board, BoardEdge, BoardNode, Json } from './schema.js';
import { BOOKKEEPING_FIELDS, changedFields } from './util.js';

export interface BuildProposalContext {
  actor: Actor;
  reason?: string;
  /** The policy verdict per operation, by batch index (from `classifyOps`). */
  verdicts: ReadonlyArray<OpVerdict | { index: number; verdict: OpVerdict }>;
  now?: Date;
  newId?: (prefix: string) => string;
}

const quote = (text: string) => JSON.stringify(text);

/**
 * Give every node and edge the batch creates a concrete id now, and replace
 * every `$ref` with it, so a preview and a later apply agree on ids. Returns
 * the rewritten batch and the ids given to refs. `add_node` keeps its `ref`.
 */
export function assignBatchIds(
  board: Board,
  ops: readonly Op[],
  newId: (prefix: string) => string = defaultNewId,
): { ops: Op[]; refs: Record<string, string> } {
  const refs: Record<string, string> = {};
  const taken = new Set<string>([...Object.keys(board.nodes), ...Object.keys(board.edges)]);
  for (const op of ops)
    if ((op.op === 'add_node' || op.op === 'add_edge') && op.id) taken.add(op.id);
  const fresh = (prefix: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = newId(prefix);
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
    throw new OpenBoardError('internal', 'could not generate a unique id');
  };
  const resolve = (target: string) =>
    target.startsWith('$') ? (refs[target.slice(1)] ?? target) : target;

  const out = ops.map((op): Op => {
    switch (op.op) {
      case 'add_node': {
        const id = op.id ?? fresh('n');
        if (op.ref !== undefined) refs[op.ref] = id;
        const node = { ...op.node };
        if (node.parent !== undefined) node.parent = resolve(node.parent);
        return { ...op, id, node };
      }
      case 'update_node': {
        const patch = { ...op.patch };
        if (typeof patch.parent === 'string') patch.parent = resolve(patch.parent);
        return { ...op, id: resolve(op.id), patch };
      }
      case 'move_node':
        return { ...op, id: resolve(op.id) };
      case 'add_edge':
        return {
          ...op,
          id: op.id ?? fresh('e'),
          edge: { ...op.edge, source: resolve(op.edge.source), target: resolve(op.edge.target) },
        };
      default:
        return op;
    }
  });
  return { ops: out, refs };
}

/** Node and edge ids an operation refers to (after `assignBatchIds`). */
function referencedIds(op: Op): string[] {
  switch (op.op) {
    case 'add_node':
      return op.node.parent !== undefined ? [op.node.parent] : [];
    case 'update_node':
      return typeof op.patch.parent === 'string' ? [op.id, op.patch.parent] : [op.id];
    case 'move_node':
    case 'remove_node':
    case 'update_edge':
    case 'remove_edge':
      return [op.id];
    case 'add_edge':
      return [op.edge.source, op.edge.target];
  }
}

/** What the canvas needs to draw `after` as ghosts over `before`. */
export function previewOf(before: Board, after: Board, applied: AppliedOps): ProposalPreview {
  const preview: ProposalPreview = {
    nodes: {},
    edges: {},
    updated: {},
    removedNodes: [...applied.removedNodes].sort(),
    removedEdges: [...applied.removedEdges].sort(),
  };
  for (const id of applied.addedNodes) {
    const node = after.nodes[id];
    if (node) preview.nodes[id] = node;
  }
  for (const id of applied.addedEdges) {
    const edge = after.edges[id];
    if (edge) preview.edges[id] = edge;
  }
  const updated = (
    a: BoardNode | BoardEdge | undefined,
    b: BoardNode | BoardEdge | undefined,
    id: string,
  ) => {
    if (!a || !b) return;
    const fields = changedFields(a, b).filter((field) => !BOOKKEEPING_FIELDS.has(field));
    if (fields.length > 0) preview.updated[id] = { fields };
  };
  for (const id of applied.updatedNodes) updated(before.nodes[id], after.nodes[id], id);
  for (const id of applied.updatedEdges) updated(before.edges[id], after.edges[id], id);
  return preview;
}

/**
 * Build the proposal for a batch that needs review: concrete ids, one item per
 * operation (free ones too, marked `needsReview: false`), dependencies, a line
 * per item for people, and the preview. Throws `invalid_request` when the
 * batch does not apply to `board`.
 */
export function buildProposal(
  board: Board,
  ops: readonly Op[],
  ctx: BuildProposalContext,
): Proposal {
  const now = ctx.now ?? new Date();
  const makeId = ctx.newId ?? defaultNewId;
  const { ops: resolved } = assignBatchIds(board, ops, makeId);
  const outcome = applyOps(board, resolved, { actor: ctx.actor, now });
  if (!outcome.ok) {
    const first = outcome.errors[0];
    throw new OpenBoardError(
      'invalid_request',
      `the batch does not apply: ops[${first?.index}]: ${first?.message}`,
      outcome.errors,
    );
  }
  const verdictAt = (index: number): OpVerdict => {
    for (const entry of ctx.verdicts) {
      if (typeof entry === 'string') continue;
      if (entry.index === index) return entry.verdict;
    }
    const plain = ctx.verdicts[index];
    return typeof plain === 'string' ? plain : 'free';
  };

  const createdAt = new Map<string, number>();
  const after = outcome.board;
  // Existing nodes are named as they are now, before the batch; new ones by their new title.
  const titleOf = (id: string) => board.nodes[id]?.title ?? after.nodes[id]?.title ?? id;
  const items: ProposalItem[] = resolved.map((op, index) => {
    const dependsOn = new Set<number>();
    for (const id of referencedIds(op)) {
      const creator = createdAt.get(id);
      if (creator !== undefined) dependsOn.add(creator);
    }
    if ((op.op === 'add_node' || op.op === 'add_edge') && op.id) createdAt.set(op.id, index);
    const item: ProposalItem = {
      index,
      op,
      status: 'pending',
      needsReview: verdictAt(index) !== 'free',
      dependsOn: [...dependsOn].sort((a, b) => a - b),
      summary: summarizeOp(op, board, titleOf),
    };
    const base = baseOf(op, board, createdAt);
    if (base) item.base = base;
    return item;
  });

  const proposal: Proposal = {
    id: makeId('p'),
    author: ctx.actor.id,
    createdAt: now.toISOString(),
    status: 'pending',
    items,
    preview: previewOf(board, after, outcome.applied),
  };
  if (ctx.reason) proposal.reason = ctx.reason;
  return proposal;
}

/**
 * A short fingerprint of a node's or edge's meaning: every field except its
 * view, bookkeeping included. Moving a node does not change it; any edit does.
 */
export function itemFingerprint(item: BoardNode | BoardEdge): string {
  const { view: _view, ...rest } = item as BoardNode;
  // The server keeps code links current (hash, moved lines, stale); that is not an edit.
  if (rest.links) {
    rest.links = rest.links.map(({ hash: _h, stale: _s, line: _l, endLine: _e, ...link }) => link);
  }
  const text = stableJson(rest);
  // FNV-1a, 32 bits: enough to tell "changed" from "unchanged".
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${item.updatedAt}#${hash.toString(36)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Fingerprint of the existing node or edge an item changes or removes. */
function baseOf(
  op: Op,
  board: Board,
  created: Map<string, number>,
): Record<string, string> | undefined {
  let item: BoardNode | BoardEdge | undefined;
  if (op.op === 'update_node' || op.op === 'remove_node') item = board.nodes[op.id];
  else if (op.op === 'update_edge' || op.op === 'remove_edge') item = board.edges[op.id];
  if (!item || created.has(item.id)) return undefined;
  return { [item.id]: itemFingerprint(item) };
}

/** The refs of the original batch and the ids the proposal gives them. */
export function proposalRefs(proposal: Proposal): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const item of proposal.items) {
    if (item.op.op === 'add_node' && item.op.ref !== undefined && item.op.id !== undefined) {
      refs[item.op.ref] = item.op.id;
    }
  }
  return refs;
}

// ── Summaries ────────────────────────────────────────────────────────────────

const BARE_FIELDS = new Set(['status', 'type']);

function scalar(field: string, value: unknown): string | null {
  if (value === undefined || value === null) return '(none)';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string' && value.length <= 60 && !value.includes('\n')) {
    return BARE_FIELDS.has(field) ? value : quote(value);
  }
  return null;
}

function fieldChange(field: string, before: unknown, after: Json | null | undefined): string {
  if (after === null) return `${field} cleared`;
  const a = scalar(field, before);
  const b = scalar(field, after);
  if (a !== null && b !== null && (before === undefined || typeof before !== 'object')) {
    return `${field} ${a} → ${b}`;
  }
  return before === undefined ? `${field} set` : `${field} edited`;
}

function edgeName(
  source: string,
  type: string,
  target: string,
  titleOf: (id: string) => string,
): string {
  return `${quote(titleOf(source))} ${type} ${quote(titleOf(target))}`;
}

/** One line a person can read, using titles rather than ids. */
export function summarizeOp(op: Op, board: Board, titleOf: (id: string) => string): string {
  switch (op.op) {
    case 'add_node': {
      const where = op.node.parent !== undefined ? ` in ${quote(titleOf(op.node.parent))}` : '';
      return `Add ${op.node.type} ${quote(op.node.title)}${where}`;
    }
    case 'update_node': {
      const node = board.nodes[op.id];
      const parts: string[] = [];
      for (const [field, value] of Object.entries(op.patch)) {
        if (value === undefined) continue;
        if (field === 'parent') {
          parts.push(
            value === null ? 'out of its frame' : `into ${quote(titleOf(value as string))}`,
          );
          continue;
        }
        const before = node ? (node as Record<string, unknown>)[field] : undefined;
        parts.push(fieldChange(field, before, value as Json | null));
      }
      return `Update ${quote(titleOf(op.id))}${parts.length ? `: ${parts.join(', ')}` : ''}`;
    }
    case 'remove_node': {
      const node = board.nodes[op.id];
      const what = node ? `${node.type} ${quote(node.title)}` : quote(titleOf(op.id));
      return `Remove ${what}${node?.type === 'frame' && op.children === 'cascade' ? ' and everything in it' : ''}`;
    }
    case 'move_node':
      return `Move ${quote(titleOf(op.id))}${board.nodes[op.id]?.view?.pinned ? ' (pinned)' : ''}`;
    case 'add_edge': {
      const label = op.edge.label ? ` labelled ${quote(op.edge.label)}` : '';
      return `Connect ${edgeName(op.edge.source, op.edge.type, op.edge.target, titleOf)}${label}`;
    }
    case 'update_edge': {
      const edge = board.edges[op.id];
      const name = edge ? edgeName(edge.source, edge.type, edge.target, titleOf) : op.id;
      const parts: string[] = [];
      if (op.patch.type !== undefined) parts.push(fieldChange('type', edge?.type, op.patch.type));
      if (op.patch.label !== undefined)
        parts.push(fieldChange('label', edge?.label, op.patch.label));
      return `Update edge ${name}${parts.length ? `: ${parts.join(', ')}` : ''}`;
    }
    case 'remove_edge': {
      const edge = board.edges[op.id];
      return `Remove edge ${edge ? edgeName(edge.source, edge.type, edge.target, titleOf) : op.id}`;
    }
  }
}

// ── Decisions ────────────────────────────────────────────────────────────────

/**
 * Expand a decision to whole, consistent sets of pending items. Accepting an
 * item accepts the pending items it depends on; rejecting one rejects the
 * pending items that depend on it. Indexes that are not pending are ignored.
 */
export function selectItems(
  proposal: Proposal,
  decision: Pick<Decision, 'action' | 'items'>,
): { accept: number[]; reject: number[] } {
  const byIndex = new Map(proposal.items.map((item) => [item.index, item]));
  const pending = (index: number) => byIndex.get(index)?.status === 'pending';
  const wanted = (decision.items ?? proposal.items.map((item) => item.index)).filter(pending);
  const chosen = new Set<number>();
  const queue = [...wanted];
  while (queue.length > 0) {
    const index = queue.pop() as number;
    if (chosen.has(index)) continue;
    chosen.add(index);
    if (decision.action === 'accept') {
      for (const dep of byIndex.get(index)?.dependsOn ?? []) if (pending(dep)) queue.push(dep);
    } else {
      for (const item of proposal.items) {
        if (item.status === 'pending' && item.dependsOn.includes(index)) queue.push(item.index);
      }
    }
  }
  const sorted = [...chosen].sort((a, b) => a - b);
  return decision.action === 'accept'
    ? { accept: sorted, reject: [] }
    : { accept: [], reject: sorted };
}

/** The operations of the given items, in batch order. */
export function proposalOps(proposal: Proposal, indexes: Iterable<number>): Op[] {
  const wanted = new Set(indexes);
  return proposal.items
    .filter((item) => wanted.has(item.index))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.op);
}

/** A proposal's status from its items: `pending` while any item is. */
export function rollupStatus(items: readonly ProposalItem[]): ProposalStatus {
  if (items.some((item) => item.status === 'pending')) return 'pending';
  const accepted = items.filter((item) => item.status === 'accepted').length;
  if (accepted === 0) return 'rejected';
  return accepted === items.length ? 'accepted' : 'partly_accepted';
}

export interface ItemCheck {
  /** Items that apply together, in batch order. */
  ok: number[];
  /** Items that do not, with why. */
  conflicts: Array<{ index: number; reason: string }>;
  /** The outcome of applying the `ok` items (always `ok: true`). */
  outcome: Extract<ApplyOutcome, { ok: true }>;
}

/**
 * Check which of `indexes` still apply to `board`: an item whose target was
 * changed or removed since it was proposed (`base`), or that fails
 * validation, is a conflict, and so is every item that depends on one. The
 * rest is validated again until it applies as a whole.
 */
export function checkItems(
  board: Board,
  proposal: Proposal,
  indexes: Iterable<number>,
  ctx: ApplyContext,
): ItemCheck {
  const byIndex = new Map(proposal.items.map((item) => [item.index, item]));
  const candidates = new Set([...indexes].filter((index) => byIndex.has(index)));
  const conflicts = new Map<number, string>();
  const label = (id: string) => {
    const actorId = board.nodes[id]?.updatedBy ?? board.edges[id]?.updatedBy;
    return actorId ? ` by ${board.actors[actorId]?.name ?? actorId}` : '';
  };
  const drop = (index: number, reason: string) => {
    if (!candidates.delete(index)) return;
    conflicts.set(index, reason);
    for (const item of proposal.items) {
      if (candidates.has(item.index) && item.dependsOn.includes(index)) {
        drop(item.index, `depends on item ${index}, which can no longer be applied`);
      }
    }
  };

  for (const index of [...candidates]) {
    const item = byIndex.get(index) as ProposalItem;
    for (const [id, fingerprint] of Object.entries(item.base ?? {})) {
      const current = board.nodes[id] ?? board.edges[id];
      const name = board.nodes[id] ? quote(board.nodes[id].title) : id;
      if (!current) drop(index, `${id} was removed after this was proposed`);
      else if (itemFingerprint(current) !== fingerprint)
        drop(index, `${name} was changed${label(id)} after this was proposed`);
    }
  }

  for (;;) {
    const ok = [...candidates].sort((a, b) => a - b);
    const ops = ok.map((index) => (byIndex.get(index) as ProposalItem).op);
    const outcome = applyOps(board, ops, ctx);
    if (outcome.ok) {
      return {
        ok,
        conflicts: [...conflicts]
          .map(([index, reason]) => ({ index, reason }))
          .sort((a, b) => a.index - b.index),
        outcome,
      };
    }
    const size = candidates.size;
    for (const error of outcome.errors) {
      const index = ok[error.index];
      if (index !== undefined) drop(index, error.message);
    }
    // Every error names an operation, so each round drops at least one; never spin.
    if (candidates.size === size)
      for (const index of ok) drop(index, 'the batch no longer applies');
  }
}
