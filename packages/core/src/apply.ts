/**
 * The operation engine: validates a batch of operations against a board and
 * computes the board that results. Pure: the input board is never modified.
 *
 * A batch is checked op by op against the evolving state, so an operation sees
 * the effect of every valid operation before it. All problems are collected;
 * if there is any, nothing is applied.
 */
import { OpenBoardError } from './api.js';
import { newId as defaultNewId } from './ids.js';
import {
  AddEdgeOpSchema,
  AddNodeOpSchema,
  type AppliedOps,
  MoveNodeOpSchema,
  type Op,
  type OpError,
  OpSchema,
  RemoveEdgeOpSchema,
  RemoveNodeOpSchema,
  UpdateEdgeOpSchema,
  UpdateNodeOpSchema,
} from './ops.js';
import {
  type Actor,
  ActorSchema,
  type Board,
  type BoardEdge,
  type BoardNode,
  LIMITS,
  type View,
  ViewSchema,
} from './schema.js';
import { formatIssues, jsonEqual, normalizeEdge, normalizeNode } from './util.js';

export interface ApplyContext {
  /** Who is making the change. Recorded on everything the batch writes. */
  actor: Actor;
  /** Timestamp for bookkeeping fields. Defaults to the current time. */
  now?: Date;
  /** Id generator for new nodes (`n`) and edges (`e`). Defaults to {@link defaultNewId}. */
  newId?: (prefix: string) => string;
  /**
   * Most operations accepted in one batch; defaults to `LIMITS.opsPerBatch`.
   * Only for the server's own writes (layout, imports), never for callers' batches.
   */
  maxOps?: number;
}

export type ApplyOutcome =
  | { ok: true; board: Board; applied: AppliedOps }
  | { ok: false; errors: OpError[] };

type OpCode = OpError['code'];

/** Validate `ops` against `board` and return the resulting board, or every problem found. */
export function applyOps(board: Board, ops: readonly Op[], ctx: ApplyContext): ApplyOutcome {
  const actor = ActorSchema.safeParse(ctx.actor);
  if (!actor.success) {
    throw new OpenBoardError('invalid_request', `invalid actor: ${formatIssues(actor.error)}`);
  }
  const maxOps = ctx.maxOps ?? LIMITS.opsPerBatch;
  if (ops.length > maxOps) {
    return {
      ok: false,
      errors: [
        {
          index: maxOps,
          code: 'invalid',
          message: `a batch holds at most ${maxOps} operations, this one has ${ops.length}; split it into smaller batches`,
        },
      ],
    };
  }
  return new BatchRun(board, actor.data, ctx).run(ops);
}

// ── Working state ────────────────────────────────────────────────────────────

/** A copy-on-write view of the board with the indexes validation needs. */
class WorkingBoard {
  readonly nodes: Map<string, BoardNode>;
  readonly edges: Map<string, BoardEdge>;
  private readonly children = new Map<string, Set<string>>();
  private readonly incident = new Map<string, Set<string>>();
  private readonly edgeKeys = new Map<string, string>();

  constructor(board: Board) {
    this.nodes = new Map(Object.entries(board.nodes));
    this.edges = new Map(Object.entries(board.edges));
    for (const node of this.nodes.values()) {
      if (node.parent !== undefined) addTo(this.children, node.parent, node.id);
    }
    for (const edge of this.edges.values()) this.indexEdge(edge);
  }

  setNode(node: BoardNode): void {
    const previous = this.nodes.get(node.id);
    if (previous?.parent !== node.parent) {
      if (previous?.parent !== undefined) removeFrom(this.children, previous.parent, node.id);
      if (node.parent !== undefined) addTo(this.children, node.parent, node.id);
    }
    this.nodes.set(node.id, node);
  }

  deleteNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.parent !== undefined) removeFrom(this.children, node.parent, id);
    this.nodes.delete(id);
  }

  setEdge(edge: BoardEdge): void {
    const previous = this.edges.get(edge.id);
    if (previous) this.unindexEdge(previous);
    this.edges.set(edge.id, edge);
    this.indexEdge(edge);
  }

  deleteEdge(id: string): void {
    const edge = this.edges.get(id);
    if (!edge) return;
    this.unindexEdge(edge);
    this.edges.delete(id);
  }

  childrenOf(id: string): string[] {
    return [...(this.children.get(id) ?? [])];
  }

  edgesOf(id: string): string[] {
    return [...(this.incident.get(id) ?? [])];
  }

  findEdge(type: string, source: string, target: string): string | undefined {
    return this.edgeKeys.get(edgeKey(type, source, target));
  }

  /** True when `ancestor` is `id` itself or one of its ancestors. */
  isSelfOrAncestor(ancestor: string, id: string): boolean {
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined && !seen.has(current)) {
      if (current === ancestor) return true;
      seen.add(current);
      current = this.nodes.get(current)?.parent;
    }
    return false;
  }

  private indexEdge(edge: BoardEdge): void {
    addTo(this.incident, edge.source, edge.id);
    addTo(this.incident, edge.target, edge.id);
    this.edgeKeys.set(edgeKey(edge.type, edge.source, edge.target), edge.id);
  }

  private unindexEdge(edge: BoardEdge): void {
    removeFrom(this.incident, edge.source, edge.id);
    removeFrom(this.incident, edge.target, edge.id);
    const key = edgeKey(edge.type, edge.source, edge.target);
    if (this.edgeKeys.get(key) === edge.id) this.edgeKeys.delete(key);
  }
}

function edgeKey(type: string, source: string, target: string): string {
  return `${type}\u0000${source}\u0000${target}`;
}

function addTo(index: Map<string, Set<string>>, key: string, value: string): void {
  let set = index.get(key);
  if (!set) {
    set = new Set();
    index.set(key, set);
  }
  set.add(value);
}

function removeFrom(index: Map<string, Set<string>>, key: string, value: string): void {
  const set = index.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) index.delete(key);
}

// ── Unknown keys ─────────────────────────────────────────────────────────────

/**
 * The schemas strip keys they do not know. For an operation that silently
 * turns a typo or a misplaced field into a no-op, so they are reported instead.
 */
const KNOWN_KEYS = {
  add_node: Object.keys(AddNodeOpSchema.shape),
  update_node: Object.keys(UpdateNodeOpSchema.shape),
  remove_node: Object.keys(RemoveNodeOpSchema.shape),
  move_node: Object.keys(MoveNodeOpSchema.shape),
  add_edge: Object.keys(AddEdgeOpSchema.shape),
  update_edge: Object.keys(UpdateEdgeOpSchema.shape),
  remove_edge: Object.keys(RemoveEdgeOpSchema.shape),
} as const;
const NODE_KEYS = Object.keys(AddNodeOpSchema.shape.node.shape);
const NODE_PATCH_KEYS = Object.keys(UpdateNodeOpSchema.shape.patch.shape);
const EDGE_KEYS = Object.keys(AddEdgeOpSchema.shape.edge.shape);
const EDGE_PATCH_KEYS = Object.keys(UpdateEdgeOpSchema.shape.patch.shape);
const VIEW_KEYS = Object.keys(ViewSchema.shape);

const KEY_HINTS: Record<string, string> = {
  'patch.view': 'use move_node to change position or size',
  'patch.id': 'ids cannot change',
  'patch.source': 'an edge cannot be re-pointed; remove it and add a new one',
  'patch.target': 'an edge cannot be re-pointed; remove it and add a new one',
};

function unknownKeys(raw: unknown, op: Op): string[] {
  const problems: string[] = [];
  const check = (value: unknown, allowed: readonly string[], path: string) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      if (allowed.includes(key)) continue;
      const full = path ? `${path}.${key}` : key;
      const hint = KEY_HINTS[full] ?? `expected one of: ${allowed.join(', ')}`;
      problems.push(`unknown field "${full}" (${hint})`);
    }
  };
  const record = raw as Record<string, unknown>;
  check(raw, KNOWN_KEYS[op.op], '');
  switch (op.op) {
    case 'add_node': {
      check(record.node, NODE_KEYS, 'node');
      const node = record.node as Record<string, unknown> | undefined;
      check(node?.view, VIEW_KEYS, 'node.view');
      break;
    }
    case 'update_node':
      check(record.patch, NODE_PATCH_KEYS, 'patch');
      break;
    case 'move_node':
      check(record.view, VIEW_KEYS, 'view');
      break;
    case 'add_edge':
      check(record.edge, EDGE_KEYS, 'edge');
      break;
    case 'update_edge':
      check(record.patch, EDGE_PATCH_KEYS, 'patch');
      break;
    default:
      break;
  }
  return problems;
}

const OP_KINDS = Object.keys(KNOWN_KEYS);

// ── The batch ────────────────────────────────────────────────────────────────

type Resolution = { kind: 'ok'; id: string } | { kind: 'error' } | { kind: 'skip' };

class BatchRun {
  private readonly w: WorkingBoard;
  private readonly errors: OpError[] = [];
  private readonly now: string;
  private readonly makeId: (prefix: string) => string;

  /** ref -> generated id, for refs whose add_node succeeded. */
  private readonly refs = new Map<string, string>();
  /** ref -> index of the op that declared it (successfully or not). */
  private readonly refDeclaredAt = new Map<string, number>();
  /** ref -> index of its first declaration anywhere in the batch. */
  private readonly refFirstDeclaration = new Map<string, number>();
  /** Refs and explicit ids of add_node ops that failed; uses of them are not reported again. */
  private readonly failedRefs = new Set<string>();
  private readonly failedIds = new Set<string>();
  /** id -> index of the op that removed it earlier in this batch. */
  private readonly removedBy = new Map<string, number>();

  private readonly reparented = new Set<string>();
  private readonly moved = new Set<string>();
  private readonly touchedNodes = new Set<string>();
  private readonly touchedEdges = new Set<string>();

  constructor(
    private readonly board: Board,
    private readonly actor: Actor,
    ctx: ApplyContext,
  ) {
    this.w = new WorkingBoard(board);
    this.now = (ctx.now ?? new Date()).toISOString();
    this.makeId = ctx.newId ?? defaultNewId;
  }

  run(ops: readonly Op[]): ApplyOutcome {
    ops.forEach((raw, index) => {
      const ref = (raw as { op?: unknown; ref?: unknown } | null)?.ref;
      if ((raw as { op?: unknown } | null)?.op === 'add_node' && typeof ref === 'string') {
        if (!this.refFirstDeclaration.has(ref)) this.refFirstDeclaration.set(ref, index);
      }
    });

    ops.forEach((raw, index) => {
      const op = this.parse(raw, index);
      if (op) this.step(op, index);
    });

    for (const id of this.reparented) {
      const node = this.w.nodes.get(id);
      if (node?.view && !this.moved.has(id)) {
        const { view: _cleared, ...rest } = node;
        this.w.setNode(rest);
      }
    }

    if (this.errors.length > 0) return { ok: false, errors: this.errors };
    return this.finish();
  }

  // ── Parsing ────────────────────────────────────────────────────────────────

  private parse(raw: unknown, index: number): Op | null {
    const kind = (raw as { op?: unknown } | null)?.op;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      this.fail(index, 'invalid', 'each operation must be an object with an "op" field');
      return null;
    }
    if (typeof kind !== 'string' || !OP_KINDS.includes(kind)) {
      this.fail(
        index,
        'invalid',
        `unknown op ${JSON.stringify(kind ?? null)}; expected one of: ${OP_KINDS.join(', ')}`,
      );
      return null;
    }
    const parsed = OpSchema.safeParse(raw);
    if (!parsed.success) {
      this.fail(index, 'invalid', `${kind}: ${formatIssues(parsed.error)}`);
      if (kind === 'add_node') {
        const { ref, id } = raw as { ref?: unknown; id?: unknown };
        this.markAddFailed(
          typeof ref === 'string' ? ref : undefined,
          typeof id === 'string' ? id : undefined,
        );
      }
      return null;
    }
    const extra = unknownKeys(raw, parsed.data);
    if (extra.length > 0) {
      this.fail(index, 'invalid', `${kind}: ${extra.join('; ')}`);
      if (parsed.data.op === 'add_node') this.markAddFailed(parsed.data.ref, parsed.data.id);
      return null;
    }
    return parsed.data;
  }

  private step(op: Op, index: number): void {
    switch (op.op) {
      case 'add_node':
        return this.addNode(op, index);
      case 'update_node':
        return this.updateNode(op, index);
      case 'remove_node':
        return this.removeNode(op, index);
      case 'move_node':
        return this.moveNode(op, index);
      case 'add_edge':
        return this.addEdge(op, index);
      case 'update_edge':
        return this.updateEdge(op, index);
      case 'remove_edge':
        return this.removeEdge(op, index);
    }
  }

  // ── Nodes ──────────────────────────────────────────────────────────────────

  private addNode(op: Extract<Op, { op: 'add_node' }>, index: number): void {
    let failed = false;
    const fail = (code: OpCode, message: string) => {
      this.fail(index, code, message);
      failed = true;
    };

    if (op.ref !== undefined) {
      const declared = this.refDeclaredAt.get(op.ref);
      if (declared !== undefined) {
        fail(
          'duplicate_ref',
          `ref "${op.ref}" is already declared by op ${declared}; give each add_node its own ref`,
        );
      }
    }
    if (op.id !== undefined) {
      const clash = this.idClash(op.id);
      if (clash) fail('duplicate_id', `${clash}; omit "id" to get a generated one`);
    }

    let parent: string | undefined;
    let skip = false;
    if (op.node.parent !== undefined) {
      const resolved = this.resolveNode(op.node.parent, index, 'parent');
      if (resolved.kind === 'ok') {
        if (this.checkFrame(resolved.id, index, 'parent')) parent = resolved.id;
        else failed = true;
      } else if (resolved.kind === 'error') failed = true;
      else skip = true;
    }

    if (op.ref !== undefined && !this.refDeclaredAt.has(op.ref)) {
      this.refDeclaredAt.set(op.ref, index);
    }
    if (failed || skip) {
      this.markAddFailed(op.ref, op.id);
      return;
    }

    const id = op.id ?? this.generateId('n');
    const { parent: _ref, ...input } = op.node;
    const node = normalizeNode({
      id,
      ...input,
      ...(parent !== undefined ? { parent } : {}),
      createdBy: this.actor.id,
      createdAt: this.now,
      updatedBy: this.actor.id,
      updatedAt: this.now,
    });
    this.w.setNode(node);
    this.removedBy.delete(id);
    if (op.ref !== undefined) this.refs.set(op.ref, id);
    this.touchedNodes.add(id);
  }

  private markAddFailed(ref: string | undefined, id: string | undefined): void {
    if (ref !== undefined && !this.refs.has(ref)) this.failedRefs.add(ref);
    if (id !== undefined && !this.w.nodes.has(id) && !this.w.edges.has(id)) this.failedIds.add(id);
  }

  private updateNode(op: Extract<Op, { op: 'update_node' }>, index: number): void {
    const target = this.resolveNode(op.id, index, 'id');
    if (target.kind !== 'ok') return;
    const id = target.id;
    const node = this.w.nodes.get(id) as BoardNode;
    const next: Record<string, unknown> = { ...node };
    let failed = false;

    for (const [key, value] of Object.entries(op.patch)) {
      if (key === 'parent' || value === undefined) continue;
      if (value === null) delete next[key];
      else next[key] = value;
    }

    if ('parent' in op.patch && op.patch.parent !== undefined) {
      if (op.patch.parent === null) {
        delete next.parent;
      } else {
        const resolved = this.resolveNode(op.patch.parent, index, 'parent');
        if (resolved.kind === 'ok') {
          const parentId = resolved.id;
          if (!this.checkFrame(parentId, index, 'parent')) failed = true;
          else if (parentId === id) {
            this.fail(index, 'cycle', `node "${id}" cannot be its own parent`);
            failed = true;
          } else if (this.w.isSelfOrAncestor(id, parentId)) {
            this.fail(
              index,
              'cycle',
              `cannot put "${id}" inside "${parentId}": "${parentId}" is already inside "${id}", which would make a cycle`,
            );
            failed = true;
          } else next.parent = parentId;
        } else failed = true;
      }
    }

    if (node.type === 'frame' && next.type !== 'frame') {
      const children = this.w.childrenOf(id);
      if (children.length > 0) {
        this.fail(
          index,
          'invalid',
          `"${id}" contains ${children.length} node${children.length === 1 ? '' : 's'} (${preview(children)}), so it must stay a frame; move or remove them first`,
        );
        failed = true;
      }
    }
    if (failed) return;

    const updated = normalizeNode(next as BoardNode);
    if (jsonEqual(updated, node)) return;
    if (updated.parent !== node.parent) this.reparented.add(id);
    this.w.setNode({ ...updated, updatedBy: this.actor.id, updatedAt: this.now });
    this.touchedNodes.add(id);
  }

  private removeNode(op: Extract<Op, { op: 'remove_node' }>, index: number): void {
    const node = this.w.nodes.get(op.id);
    if (!node) {
      if (this.removedBy.has(op.id)) return; // already gone; removing twice is harmless
      this.fail(index, 'not_found', this.missingNodeMessage(op.id));
      return;
    }

    const doomed = [op.id];
    if (node.type === 'frame') {
      if (op.children === 'cascade') {
        for (let i = 0; i < doomed.length; i++) {
          doomed.push(...this.w.childrenOf(doomed[i] as string));
        }
      } else {
        for (const childId of this.w.childrenOf(op.id)) this.liftChild(childId, node);
      }
    }

    for (const id of doomed) {
      for (const edgeId of this.w.edgesOf(id)) {
        this.w.deleteEdge(edgeId);
        this.removedBy.set(edgeId, index);
        this.touchedEdges.add(edgeId);
      }
    }
    for (const id of doomed) {
      this.w.deleteNode(id);
      this.removedBy.set(id, index);
      this.touchedNodes.add(id);
    }
  }

  /**
   * Move a child of a removed frame to the frame's own parent, keeping it where
   * it is on screen. When the frame had no position there is nothing to convert
   * from, so the child's position is cleared and layout places it again.
   */
  private liftChild(childId: string, frame: BoardNode): void {
    const child = this.w.nodes.get(childId);
    if (!child) return;
    const { parent: _old, view, ...rest } = child;
    const next: BoardNode = {
      ...rest,
      ...(frame.parent !== undefined ? { parent: frame.parent } : {}),
      updatedBy: this.actor.id,
      updatedAt: this.now,
    };
    if (view && frame.view)
      next.view = { ...view, x: view.x + frame.view.x, y: view.y + frame.view.y };
    this.w.setNode(next);
    this.touchedNodes.add(childId);
  }

  private moveNode(op: Extract<Op, { op: 'move_node' }>, index: number): void {
    const target = this.resolveNode(op.id, index, 'id');
    if (target.kind !== 'ok') return;
    const node = this.w.nodes.get(target.id) as BoardNode;
    const merged = { ...node.view, ...op.view };
    if (merged.x === undefined || merged.y === undefined) {
      this.fail(
        index,
        'invalid',
        `node "${target.id}" has no position yet, so move_node must give both "x" and "y"`,
      );
      return;
    }
    const view: View = ViewSchema.parse(merged);
    this.moved.add(target.id);
    if (jsonEqual(view, node.view)) return;
    this.w.setNode({ ...node, view });
    this.touchedNodes.add(target.id);
  }

  // ── Edges ──────────────────────────────────────────────────────────────────

  private addEdge(op: Extract<Op, { op: 'add_edge' }>, index: number): void {
    let failed = false;
    if (op.id !== undefined) {
      const clash = this.idClash(op.id);
      if (clash) {
        this.fail(index, 'duplicate_id', `${clash}; omit "id" to get a generated one`);
        failed = true;
      }
    }
    const source = this.resolveNode(op.edge.source, index, 'source');
    const target = this.resolveNode(op.edge.target, index, 'target');
    if (source.kind !== 'ok' || target.kind !== 'ok' || failed) return;

    if (source.id === target.id) {
      this.fail(index, 'self_edge', `an edge cannot connect "${source.id}" to itself`);
      return;
    }
    const existing = this.w.findEdge(op.edge.type, source.id, target.id);
    if (existing !== undefined) {
      this.fail(
        index,
        'duplicate_edge',
        `a ${op.edge.type} edge from "${source.id}" to "${target.id}" already exists ("${existing}"); use update_edge to change it`,
      );
      return;
    }

    const id = op.id ?? this.generateId('e');
    const edge = normalizeEdge({
      id,
      type: op.edge.type,
      source: source.id,
      target: target.id,
      ...(op.edge.label !== undefined ? { label: op.edge.label } : {}),
      createdBy: this.actor.id,
      createdAt: this.now,
      updatedBy: this.actor.id,
      updatedAt: this.now,
    });
    this.w.setEdge(edge);
    this.removedBy.delete(id);
    this.touchedEdges.add(id);
  }

  private updateEdge(op: Extract<Op, { op: 'update_edge' }>, index: number): void {
    const edge = this.w.edges.get(op.id);
    if (!edge) {
      this.fail(index, 'not_found', this.missingEdgeMessage(op.id));
      return;
    }
    const next: Record<string, unknown> = { ...edge };
    if (op.patch.type !== undefined) next.type = op.patch.type;
    if (op.patch.label === null) delete next.label;
    else if (op.patch.label !== undefined) next.label = op.patch.label;

    const updated = normalizeEdge(next as BoardEdge);
    if (updated.type !== edge.type) {
      const existing = this.w.findEdge(updated.type, edge.source, edge.target);
      if (existing !== undefined && existing !== edge.id) {
        this.fail(
          index,
          'duplicate_edge',
          `a ${updated.type} edge from "${edge.source}" to "${edge.target}" already exists ("${existing}"); remove one of them instead`,
        );
        return;
      }
    }
    if (jsonEqual(updated, edge)) return;
    this.w.setEdge({ ...updated, updatedBy: this.actor.id, updatedAt: this.now });
    this.touchedEdges.add(edge.id);
  }

  private removeEdge(op: Extract<Op, { op: 'remove_edge' }>, index: number): void {
    if (!this.w.edges.has(op.id)) {
      if (this.removedBy.has(op.id)) return; // already gone; removing twice is harmless
      this.fail(index, 'not_found', this.missingEdgeMessage(op.id));
      return;
    }
    this.w.deleteEdge(op.id);
    this.removedBy.set(op.id, index);
    this.touchedEdges.add(op.id);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private fail(index: number, code: OpCode, message: string): void {
    this.errors.push({ index, code, message });
  }

  /** Resolve a node id or "$ref". Reports its own error, or skips quietly when the cause was already reported. */
  private resolveNode(target: string, index: number, field: string): Resolution {
    if (target.startsWith('$')) {
      const ref = target.slice(1);
      const id = this.refs.get(ref);
      if (id !== undefined) {
        if (this.w.nodes.has(id)) return { kind: 'ok', id };
        this.fail(
          index,
          'not_found',
          `${field} "${target}" names node "${id}", which op ${this.removedBy.get(id) ?? '?'} removed earlier in this batch`,
        );
        return { kind: 'error' };
      }
      if (this.failedRefs.has(ref)) return { kind: 'skip' };
      const later = this.refFirstDeclaration.get(ref);
      const known = [...this.refs.keys()].map((r) => `$${r}`);
      const message =
        later !== undefined && later > index
          ? `${field} "${target}" is declared later, by op ${later}; move that add_node before op ${index}`
          : `${field} "${target}" does not name a node added earlier in this batch; ${
              known.length ? `refs available here: ${known.join(', ')}` : 'no refs are declared yet'
            }`;
      this.fail(index, 'unknown_ref', message);
      return { kind: 'error' };
    }
    if (this.w.nodes.has(target)) return { kind: 'ok', id: target };
    if (this.failedIds.has(target)) return { kind: 'skip' };
    this.fail(index, 'not_found', `${field}: ${this.missingNodeMessage(target)}`);
    return { kind: 'error' };
  }

  private checkFrame(id: string, index: number, field: string): boolean {
    const node = this.w.nodes.get(id) as BoardNode;
    if (node.type === 'frame') return true;
    this.fail(
      index,
      'not_a_frame',
      `${field} "${id}" is a ${node.type} (${JSON.stringify(node.title)}), not a frame; only frames can contain nodes`,
    );
    return false;
  }

  private missingNodeMessage(id: string): string {
    const removed = this.removedBy.get(id);
    if (removed !== undefined)
      return `node "${id}" was removed by op ${removed} earlier in this batch`;
    if (this.w.edges.has(id)) return `"${id}" is an edge, not a node`;
    return `node "${id}" does not exist`;
  }

  private missingEdgeMessage(id: string): string {
    if (this.w.nodes.has(id)) return `"${id}" is a node, not an edge`;
    return `edge "${id}" does not exist`;
  }

  private idClash(id: string): string | null {
    const node = this.w.nodes.get(id);
    if (node) return `node "${id}" already exists (${node.type} ${JSON.stringify(node.title)})`;
    if (this.w.edges.has(id)) return `"${id}" is already the id of an edge`;
    return null;
  }

  private generateId(prefix: string): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = this.makeId(prefix);
      if (!this.w.nodes.has(id) && !this.w.edges.has(id) && !this.removedBy.has(id)) return id;
    }
    throw new OpenBoardError('internal', 'could not generate a unique id');
  }

  // ── Result ─────────────────────────────────────────────────────────────────

  private finish(): ApplyOutcome {
    const applied: AppliedOps = {
      refs: Object.fromEntries(this.refs),
      addedNodes: [],
      updatedNodes: [],
      removedNodes: [],
      addedEdges: [],
      updatedEdges: [],
      removedEdges: [],
    };
    let semantic = false;
    let authored = false;

    for (const id of this.touchedNodes) {
      const before = this.board.nodes[id];
      const after = this.w.nodes.get(id);
      if (!before && after) {
        applied.addedNodes.push(id);
        semantic = authored = true;
      } else if (before && !after) {
        applied.removedNodes.push(id);
        semantic = true;
      } else if (before && after && !jsonEqual(before, after)) {
        applied.updatedNodes.push(id);
        const { view: _a, ...b } = before;
        const { view: _b, ...a } = after;
        if (!jsonEqual(a, b)) semantic = authored = true;
      }
    }
    for (const id of this.touchedEdges) {
      const before = this.board.edges[id];
      const after = this.w.edges.get(id);
      if (!before && after) {
        applied.addedEdges.push(id);
        semantic = authored = true;
      } else if (before && !after) {
        applied.removedEdges.push(id);
        semantic = true;
      } else if (before && after && !jsonEqual(before, after)) {
        applied.updatedEdges.push(id);
        semantic = authored = true;
      }
    }

    const changed =
      applied.addedNodes.length +
        applied.updatedNodes.length +
        applied.removedNodes.length +
        applied.addedEdges.length +
        applied.updatedEdges.length +
        applied.removedEdges.length >
      0;
    if (!changed) return { ok: true, board: this.board, applied };

    let actors = this.board.actors;
    if (authored && !jsonEqual(actors[this.actor.id], this.actor)) {
      actors = { ...actors, [this.actor.id]: this.actor };
    }
    const board: Board = {
      ...this.board,
      updatedAt: semantic ? this.now : this.board.updatedAt,
      actors,
      nodes: Object.fromEntries(this.w.nodes),
      edges: Object.fromEntries(this.w.edges),
    };
    return { ok: true, board, applied };
  }
}

function preview(ids: string[]): string {
  const shown = ids.slice(0, 3).map((id) => `"${id}"`);
  return ids.length > 3 ? `${shown.join(', ')}, ...` : shown.join(', ');
}
