/**
 * The live board: a Yjs document with the layout described in
 * docs/ARCHITECTURE.md ("The board document").
 *
 *   meta    Y.Map   schemaVersion, id, name, description, createdAt, updatedAt
 *   actors  Y.Map   plain actor objects by id
 *   nodes   Y.Map   one Y.Map per node, one key per field, plain JSON values
 *   edges   Y.Map   one Y.Map per edge, same shape
 *
 * `BoardDoc` is the only code that reads or writes these maps. It keeps a
 * parsed copy of every entry, refreshed after each transaction, so reads are
 * cheap and change events can be derived by comparing old and new values.
 * Entries written by a misbehaving peer that fail validation are skipped and
 * reported through `issues()` rather than thrown.
 */
import * as Y from 'yjs';
import type { ChangeKind } from './api.js';
import { OpenBoardError } from './api.js';
import { type ApplyContext, type ApplyOutcome, applyOps } from './apply.js';
import type { AppliedOps, Op } from './ops.js';
import {
  type Actor,
  ActorSchema,
  type Board,
  type BoardEdge,
  type BoardMeta,
  BoardMetaSchema,
  type BoardNode,
  type BoardSummary,
  EdgeSchema,
  IdSchema,
  NodeSchema,
  SCHEMA_VERSION,
  type TxOrigin,
} from './schema.js';
import { emptyBoard } from './serialize.js';
import {
  BOOKKEEPING_FIELDS,
  changedFields,
  cloneJson,
  compareStrings,
  deepFreeze,
  formatIssues,
  jsonEqual,
  normalizeEdge,
  normalizeNode,
} from './util.js';

/** One normalized change to a node or edge. */
export interface DocChange {
  kind: ChangeKind;
  /** Node or edge id. */
  id: string;
  /** For updates: which fields changed (bookkeeping fields are left out). */
  fields?: string[];
  /** Node title, or "source title -> target title" for an edge. For removals, the title before removal. */
  title?: string;
}

/** Everything one transaction changed. */
export interface DocEvent {
  changes: DocChange[];
  /** The transaction's origin, or null when it was not a `TxOrigin` (for example a sync provider). */
  origin: TxOrigin | null;
  /** True when the transaction was made on this replica, false when it arrived from a peer. */
  local: boolean;
  /** True when board metadata or the actor registry changed. */
  metaChanged: boolean;
}

export type DocListener = (event: DocEvent) => void;

export interface DocApplyContext extends ApplyContext {
  /** Recorded in the transaction origin. Defaults to `ops`. */
  source?: TxOrigin['source'];
}

const TX_SOURCES: ReadonlySet<string> = new Set(['ops', 'ui', 'layout', 'file', 'undo', 'sync']);
const META_KEYS = ['schemaVersion', 'id', 'name', 'description', 'createdAt', 'updatedAt'] as const;
const EPOCH = '1970-01-01T00:00:00.000Z';

function isTxOrigin(value: unknown): value is TxOrigin {
  if (typeof value !== 'object' || value === null) return false;
  const { actorId, source } = value as Partial<TxOrigin>;
  return typeof actorId === 'string' && typeof source === 'string' && TX_SOURCES.has(source);
}

interface Touched {
  meta: boolean;
  actors: Set<string>;
  nodes: Set<string>;
  edges: Set<string>;
}

type Entry<T> = { value: T } | { issue: string };

export class BoardDoc {
  readonly ydoc: Y.Doc;
  private readonly metaMap: Y.Map<unknown>;
  private readonly actorsMap: Y.Map<unknown>;
  private readonly nodesMap: Y.Map<unknown>;
  private readonly edgesMap: Y.Map<unknown>;

  private metaState: { meta: BoardMeta; issues: string[]; ready: boolean };
  private readonly actorCache = new Map<string, Actor>();
  private readonly nodeCache = new Map<string, BoardNode>();
  private readonly edgeCache = new Map<string, BoardEdge>();
  /** Problems with individual entries, keyed by `nodes/<id>`, `edges/<id>` or `actors/<id>`. */
  private readonly entryIssues = new Map<string, string>();
  private boardCache: { board: Board; issues: string[] } | null = null;

  private readonly origins = new Map<string, TxOrigin>();
  private readonly undoOrigins = new WeakMap<Y.UndoManager, TxOrigin>();
  private readonly listeners = new Set<DocListener>();
  private readonly pending = new Map<Y.Transaction, Touched>();
  private readonly detach: Array<() => void> = [];

  private constructor(ydoc: Y.Doc) {
    this.ydoc = ydoc;
    this.metaMap = ydoc.getMap('meta');
    this.actorsMap = ydoc.getMap('actors');
    this.nodesMap = ydoc.getMap('nodes');
    this.edgesMap = ydoc.getMap('edges');

    this.metaState = this.readMeta();
    for (const id of this.actorsMap.keys()) this.refreshActor(id);
    for (const id of this.nodesMap.keys()) this.refreshNode(id);
    for (const id of this.edgesMap.keys()) this.refreshEdge(id);

    this.watch(this.metaMap, (touched) => {
      touched.meta = true;
    });
    this.watch(this.actorsMap, (touched, id) => touched.actors.add(id));
    this.watch(this.nodesMap, (touched, id) => touched.nodes.add(id));
    this.watch(this.edgesMap, (touched, id) => touched.edges.add(id));
    const onAfter = (tr: Y.Transaction) => this.flush(tr);
    ydoc.on('afterTransaction', onAfter);
    this.detach.push(() => ydoc.off('afterTransaction', onAfter));
  }

  // ── Construction ───────────────────────────────────────────────────────────

  /** A new, empty board. */
  static create(
    meta: { id: string; name: string; description?: string },
    opts?: { now?: Date },
  ): BoardDoc {
    return BoardDoc.fromJSON(emptyBoard(meta, opts?.now));
  }

  /** A document holding exactly `board`. */
  static fromJSON(board: Board): BoardDoc {
    const ydoc = new Y.Doc();
    const doc = new BoardDoc(ydoc);
    doc.reconcile(board, doc.origin('system', 'file'));
    return doc;
  }

  /**
   * Wrap a document that is being synced. It may still be empty; `ready`
   * turns true once the board metadata has arrived.
   */
  static fromYDoc(ydoc: Y.Doc): BoardDoc {
    return new BoardDoc(ydoc);
  }

  /** A document restored from `encodeState()` output. */
  static fromUpdate(update: Uint8Array): BoardDoc {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, update);
    return new BoardDoc(ydoc);
  }

  /** The full document state, including history, as one Yjs update. */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc);
  }

  /** Stop listening to the underlying document. Listeners registered with `observe` stop firing. */
  destroy(): void {
    for (const off of this.detach.splice(0)) off();
    this.listeners.clear();
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /** False until valid board metadata is present (for example before the first sync). */
  get ready(): boolean {
    return this.metaState.ready;
  }

  /** Board metadata. Missing or invalid fields fall back to placeholders and are listed by `issues()`. */
  get meta(): BoardMeta {
    return this.metaState.meta;
  }

  /** A node by id, or undefined. A `parent` that no longer names a frame is left out. */
  getNode(id: string): BoardNode | undefined {
    const node = this.nodeCache.get(id);
    return node && this.withValidParent(node);
  }

  /** An edge by id, or undefined when it does not exist or an endpoint is missing. */
  getEdge(id: string): BoardEdge | undefined {
    const edge = this.edgeCache.get(id);
    return edge && this.hasEndpoints(edge) ? edge : undefined;
  }

  nodes(): BoardNode[] {
    return [...this.nodeCache.values()].map((node) => this.withValidParent(node));
  }

  edges(): BoardEdge[] {
    return [...this.edgeCache.values()].filter((edge) => this.hasEndpoints(edge));
  }

  summary(): BoardSummary {
    let edgeCount = 0;
    for (const edge of this.edgeCache.values()) if (this.hasEndpoints(edge)) edgeCount++;
    return { ...this.metaState.meta, nodeCount: this.nodeCache.size, edgeCount };
  }

  /**
   * The board as plain JSON, always satisfying the semantic rules: entries that
   * fail validation, dangling parents, parent cycles, dangling, self and
   * duplicate edges are left out and described by `issues()`.
   *
   * Node and edge objects are frozen and shared between calls; the returned
   * board and its records are fresh.
   */
  toJSON(): Board {
    const { board } = this.sanitized();
    return {
      ...board,
      actors: { ...board.actors },
      nodes: { ...board.nodes },
      edges: { ...board.edges },
    };
  }

  /** What `toJSON()` had to skip or repair, one line each. Empty for a healthy document. */
  issues(): string[] {
    return [...this.metaState.issues, ...this.entryIssues.values(), ...this.sanitized().issues];
  }

  // ── Transactions ───────────────────────────────────────────────────────────

  /**
   * The transaction origin for an actor and source. The same pair always
   * returns the same object, so it can be used in `Y.UndoManager.trackedOrigins`.
   */
  origin(actorId: string, source: TxOrigin['source']): TxOrigin {
    const key = `${actorId}\u0000${source}`;
    let origin = this.origins.get(key);
    if (!origin) {
      origin = Object.freeze({ actorId, source });
      this.origins.set(key, origin);
    }
    return origin;
  }

  /**
   * Validate and apply a batch of operations. On success the changed fields
   * (and only those) are written in one transaction tagged with
   * `origin(actor.id, source ?? 'ops')`.
   *
   * Do not call this from inside another transaction on the same document:
   * validation reads the state as of the last completed transaction.
   */
  apply(ops: readonly Op[], ctx: DocApplyContext): ApplyOutcome {
    const before = this.toJSON();
    const result = applyOps(before, ops, ctx);
    if (!result.ok || result.board === before) return result;
    const after = result.board;
    const writes: Array<() => void> = [];

    for (const key of META_KEYS) {
      if (!jsonEqual(before[key], after[key]))
        writes.push(() => setOrDelete(this.metaMap, key, after[key]));
    }
    for (const id of unionKeys(before.actors, after.actors)) {
      const value = after.actors[id];
      if (!jsonEqual(before.actors[id], value))
        writes.push(() => setOrDelete(this.actorsMap, id, value));
    }
    this.planEntries(this.nodesMap, before.nodes, after.nodes, writes);
    this.planEntries(this.edgesMap, before.edges, after.edges, writes);

    if (writes.length > 0) {
      this.ydoc.transact(
        () => {
          for (const write of writes) write();
        },
        this.origin(ctx.actor.id, ctx.source ?? 'ops'),
      );
    }
    return result;
  }

  /** Rename the board or change its description. Returns false when nothing changed. */
  setMeta(
    patch: { name?: string; description?: string | null },
    actor: Actor,
    opts?: { source?: TxOrigin['source']; now?: Date },
  ): boolean {
    const current = this.metaState.meta;
    const next: Record<string, unknown> = { ...current };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.description === null) delete next.description;
    else if (patch.description !== undefined) next.description = patch.description;
    if (next.description === '') delete next.description;

    const parsed = BoardMetaSchema.safeParse(next);
    if (!parsed.success) {
      throw new OpenBoardError(
        'invalid_request',
        `invalid board metadata: ${formatIssues(parsed.error)}`,
      );
    }
    if (jsonEqual(parsed.data, current)) return false;
    const actorParsed = ActorSchema.safeParse(actor);
    if (!actorParsed.success) {
      throw new OpenBoardError(
        'invalid_request',
        `invalid actor: ${formatIssues(actorParsed.error)}`,
      );
    }

    const meta = { ...parsed.data, updatedAt: (opts?.now ?? new Date()).toISOString() };
    this.ydoc.transact(
      () => {
        if (this.metaMap.get('schemaVersion') !== SCHEMA_VERSION) {
          this.metaMap.set('schemaVersion', SCHEMA_VERSION);
        }
        for (const key of ['id', 'name', 'description', 'createdAt', 'updatedAt'] as const) {
          if (!jsonEqual(this.metaMap.get(key), meta[key]))
            setOrDelete(this.metaMap, key, meta[key]);
        }
        if (!jsonEqual(this.actorsMap.get(actorParsed.data.id), actorParsed.data)) {
          this.actorsMap.set(actorParsed.data.id, cloneJson(actorParsed.data));
        }
      },
      this.origin(actorParsed.data.id, opts?.source ?? 'ops'),
    );
    return true;
  }

  /**
   * Make the document equal to `target` with as few writes as possible. All
   * values, bookkeeping included, are taken from `target` verbatim; entries
   * and fields that `target` lacks are deleted. Nothing is written (and no
   * transaction is opened) when the document already matches.
   */
  reconcile(target: Board, origin: TxOrigin): AppliedOps {
    const applied: AppliedOps = {
      refs: {},
      addedNodes: [],
      updatedNodes: [],
      removedNodes: [],
      addedEdges: [],
      updatedEdges: [],
      removedEdges: [],
    };
    const writes: Array<() => void> = [];

    const desiredMeta: Record<string, unknown> = {};
    for (const key of META_KEYS) if (target[key] !== undefined) desiredMeta[key] = target[key];
    planExact(this.metaMap, desiredMeta, writes);

    for (const id of this.actorsMap.keys()) {
      if (!(id in target.actors)) writes.push(() => this.actorsMap.delete(id));
    }
    for (const [id, actor] of Object.entries(target.actors)) {
      if (!jsonEqual(this.actorsMap.get(id), actor))
        writes.push(() => this.actorsMap.set(id, cloneJson(actor)));
    }

    const sync = (
      map: Y.Map<unknown>,
      cache: Map<string, unknown>,
      desired: Record<string, BoardNode | BoardEdge>,
      added: string[],
      updated: string[],
      removed: string[],
    ) => {
      for (const id of map.keys()) {
        if (id in desired) continue;
        writes.push(() => map.delete(id));
        if (cache.has(id)) removed.push(id);
      }
      for (const [id, value] of Object.entries(desired)) {
        const raw = map.get(id);
        if (raw instanceof Y.Map) {
          const before = writes.length;
          planExact(raw, value as unknown as Record<string, unknown>, writes);
          if (writes.length > before) (cache.has(id) ? updated : added).push(id);
        } else {
          writes.push(() => map.set(id, toYMap(value)));
          added.push(id);
        }
      }
    };
    sync(
      this.nodesMap,
      this.nodeCache,
      target.nodes,
      applied.addedNodes,
      applied.updatedNodes,
      applied.removedNodes,
    );
    sync(
      this.edgesMap,
      this.edgeCache,
      target.edges,
      applied.addedEdges,
      applied.updatedEdges,
      applied.removedEdges,
    );

    if (writes.length > 0) {
      this.ydoc.transact(() => {
        for (const write of writes) write();
      }, origin);
    }
    return applied;
  }

  // ── Events and undo ────────────────────────────────────────────────────────

  /**
   * Listen to changes. The listener runs once per transaction that changed the
   * board, local or remote. Returns a function that stops listening.
   */
  observe(listener: DocListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * An undo manager for one actor's changes to nodes and edges. It tracks
   * transactions whose origin is `origin(actorId, source)` for each of
   * `sources` (default `ops` and `ui`); one `apply` call is one undo step.
   * Board metadata and the actor registry are not undone.
   *
   * Transactions made by this undo manager are reported to `observe` with the
   * origin `origin(actorId, 'undo')`.
   */
  createUndoManager(actorId: string, sources: TxOrigin['source'][] = ['ops', 'ui']): Y.UndoManager {
    const manager = new Y.UndoManager([this.nodesMap, this.edgesMap], {
      trackedOrigins: new Set(sources.map((source) => this.origin(actorId, source))),
      captureTimeout: 0,
    });
    this.undoOrigins.set(manager, this.origin(actorId, 'undo'));
    return manager;
  }

  // ── Internals: change tracking ─────────────────────────────────────────────

  private watch(map: Y.Map<unknown>, mark: (touched: Touched, id: string) => void): void {
    const handler = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, tr: Y.Transaction) => {
      let touched = this.pending.get(tr);
      if (!touched) {
        touched = { meta: false, actors: new Set(), nodes: new Set(), edges: new Set() };
        this.pending.set(tr, touched);
      }
      for (const event of events) {
        if (event.target === map) {
          for (const key of (event as Y.YMapEvent<unknown>).keysChanged) {
            if (typeof key === 'string') mark(touched, key);
          }
        } else {
          const id = event.path[0];
          if (typeof id === 'string') mark(touched, id);
        }
      }
    };
    map.observeDeep(handler);
    this.detach.push(() => map.unobserveDeep(handler));
  }

  private flush(tr: Y.Transaction): void {
    const touched = this.pending.get(tr);
    if (!touched) return;
    this.pending.delete(tr);
    this.boardCache = null;

    // Titles as they were before this transaction, for removals and edge titles.
    // Changes are reported nodes first, then edges, each sorted by id.
    const oldNodes = new Map<string, BoardNode | undefined>();
    for (const id of [...touched.nodes].sort(compareStrings))
      oldNodes.set(id, this.nodeCache.get(id));
    const oldEdges = new Map<string, BoardEdge | undefined>();
    for (const id of [...touched.edges].sort(compareStrings))
      oldEdges.set(id, this.edgeCache.get(id));

    let metaChanged = false;
    if (touched.meta) {
      const previous = this.metaState;
      this.metaState = this.readMeta();
      metaChanged =
        !jsonEqual(previous.meta, this.metaState.meta) || previous.ready !== this.metaState.ready;
    }
    for (const id of touched.actors) {
      const previous = this.actorCache.get(id);
      this.refreshActor(id);
      if (!jsonEqual(previous, this.actorCache.get(id))) metaChanged = true;
    }
    for (const id of touched.nodes) this.refreshNode(id);
    for (const id of touched.edges) this.refreshEdge(id);

    const oldTitle = (id: string) =>
      (oldNodes.has(id) ? oldNodes.get(id) : this.nodeCache.get(id))?.title ?? id;
    const newTitle = (id: string) => this.nodeCache.get(id)?.title ?? oldTitle(id);
    const changes: DocChange[] = [];

    for (const [id, before] of oldNodes) {
      const after = this.nodeCache.get(id);
      const change = describe(before, after, 'node');
      if (!change) continue;
      const title = (change === 'node_removed' ? before?.title : after?.title) ?? id;
      changes.push(withFields({ kind: change, id, title }, before, after));
    }
    for (const [id, before] of oldEdges) {
      const after = this.edgeCache.get(id);
      const change = describe(before, after, 'edge');
      if (!change) continue;
      // An endpoint that still exists is named as it is now; one removed with
      // the edge is named as it was.
      const edge = (after ?? before) as BoardEdge;
      const title = `${newTitle(edge.source)} -> ${newTitle(edge.target)}`;
      changes.push(withFields({ kind: change, id, title }, before, after));
    }

    if (changes.length === 0 && !metaChanged) return;
    const event: DocEvent = { changes, origin: this.originOf(tr), local: tr.local, metaChanged };
    for (const listener of [...this.listeners]) listener(event);
  }

  private originOf(tr: Y.Transaction): TxOrigin | null {
    const origin: unknown = tr.origin;
    if (origin instanceof Y.UndoManager) return this.undoOrigins.get(origin) ?? null;
    return isTxOrigin(origin) ? origin : null;
  }

  // ── Internals: parsing entries ─────────────────────────────────────────────

  private readMeta(): { meta: BoardMeta; issues: string[]; ready: boolean } {
    const raw = this.metaMap.toJSON() as Record<string, unknown>;
    if (Object.keys(raw).length === 0) {
      return {
        meta: { id: 'unknown', name: 'Untitled board', createdAt: EPOCH, updatedAt: EPOCH },
        issues: ['board metadata is missing (the document may not have synced yet)'],
        ready: false,
      };
    }
    const parsed = BoardMetaSchema.safeParse(raw);
    const issues: string[] = [];
    if (raw.schemaVersion !== SCHEMA_VERSION) {
      issues.push(
        `meta.schemaVersion is ${JSON.stringify(raw.schemaVersion ?? null)}, expected ${SCHEMA_VERSION}`,
      );
    }
    if (parsed.success) return { meta: deepFreeze(parsed.data), issues, ready: true };

    issues.push(`board metadata is invalid: ${formatIssues(parsed.error, ['meta'])}`);
    const field = <K extends keyof BoardMeta>(key: K, fallback: BoardMeta[K]): BoardMeta[K] => {
      const result = BoardMetaSchema.shape[key].safeParse(raw[key]);
      return result.success ? (result.data as BoardMeta[K]) : fallback;
    };
    const meta: BoardMeta = {
      id: field('id', 'unknown'),
      name: field('name', 'Untitled board'),
      createdAt: field('createdAt', EPOCH),
      updatedAt: field('updatedAt', EPOCH),
    };
    const description = field('description', undefined);
    if (description !== undefined) meta.description = description;
    return { meta: deepFreeze(meta), issues, ready: false };
  }

  private refreshActor(id: string): void {
    const raw = this.actorsMap.get(id);
    this.store(this.actorCache, `actors/${id}`, raw === undefined ? null : parseActor(id, raw));
  }

  private refreshNode(id: string): void {
    const raw = this.nodesMap.get(id);
    this.store(this.nodeCache, `nodes/${id}`, raw === undefined ? null : parseNode(id, raw));
  }

  private refreshEdge(id: string): void {
    const raw = this.edgesMap.get(id);
    this.store(this.edgeCache, `edges/${id}`, raw === undefined ? null : parseEdge(id, raw));
  }

  private store<T>(cache: Map<string, T>, key: string, entry: Entry<T> | null): void {
    const id = key.slice(key.indexOf('/') + 1);
    this.entryIssues.delete(key);
    if (entry === null) cache.delete(id);
    else if ('value' in entry) cache.set(id, entry.value);
    else {
      cache.delete(id);
      this.entryIssues.set(key, entry.issue);
    }
  }

  // ── Internals: the repaired board ──────────────────────────────────────────

  private withValidParent(node: BoardNode): BoardNode {
    if (node.parent === undefined) return node;
    const parent = this.nodeCache.get(node.parent);
    if (parent?.type === 'frame') return node;
    const { parent: _dropped, ...rest } = node;
    return rest;
  }

  private hasEndpoints(edge: BoardEdge): boolean {
    return this.nodeCache.has(edge.source) && this.nodeCache.has(edge.target);
  }

  private sanitized(): { board: Board; issues: string[] } {
    if (this.boardCache) return this.boardCache;
    const issues: string[] = [];

    const nodes = new Map<string, BoardNode>();
    for (const id of [...this.nodeCache.keys()].sort(compareStrings)) {
      const node = this.nodeCache.get(id) as BoardNode;
      const fixed = this.withValidParent(node);
      if (fixed !== node) {
        issues.push(
          `node "${id}": parent "${node.parent}" is not an existing frame; shown without a parent`,
        );
      }
      nodes.set(id, fixed);
    }
    // Concurrent re-parenting can produce a cycle; break it at its smallest id.
    const done = new Set<string>();
    for (const id of nodes.keys()) {
      const path: string[] = [];
      let current: string | undefined = id;
      while (current !== undefined && !done.has(current) && !path.includes(current)) {
        path.push(current);
        current = nodes.get(current)?.parent;
      }
      if (current !== undefined && path.includes(current)) {
        const cycle = path.slice(path.indexOf(current));
        const breakAt = [...cycle].sort(compareStrings)[0] as string;
        const { parent: _dropped, ...rest } = nodes.get(breakAt) as BoardNode;
        nodes.set(breakAt, rest);
        issues.push(
          `nodes ${cycle.map((c) => `"${c}"`).join(', ')} form a parent cycle; "${breakAt}" is shown without a parent`,
        );
      }
      for (const visited of path) done.add(visited);
    }

    const edges = new Map<string, BoardEdge>();
    const keys = new Map<string, string>();
    for (const id of [...this.edgeCache.keys()].sort(compareStrings)) {
      const edge = this.edgeCache.get(id) as BoardEdge;
      if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
        const missing = nodes.has(edge.source) ? edge.target : edge.source;
        issues.push(`edge "${id}" skipped: node "${missing}" does not exist`);
        continue;
      }
      const key = `${edge.type}\u0000${edge.source}\u0000${edge.target}`;
      const other = keys.get(key);
      if (other !== undefined) {
        issues.push(`edge "${id}" skipped: it duplicates edge "${other}"`);
        continue;
      }
      keys.set(key, id);
      edges.set(id, edge);
    }

    const actors: Record<string, Actor> = {};
    for (const id of [...this.actorCache.keys()].sort(compareStrings)) {
      actors[id] = this.actorCache.get(id) as Actor;
    }

    const board: Board = {
      schemaVersion: SCHEMA_VERSION,
      ...this.metaState.meta,
      actors,
      nodes: Object.fromEntries(nodes),
      edges: Object.fromEntries(edges),
    };
    this.boardCache = { board, issues };
    return this.boardCache;
  }

  // ── Internals: writing ─────────────────────────────────────────────────────

  /** Plan the writes that turn `before` into `after`, touching only changed fields. */
  private planEntries(
    map: Y.Map<unknown>,
    before: Record<string, BoardNode | BoardEdge>,
    after: Record<string, BoardNode | BoardEdge>,
    writes: Array<() => void>,
  ): void {
    for (const id of unionKeys(before, after)) {
      const a = before[id];
      const b = after[id];
      if (a && !b) writes.push(() => map.delete(id));
      else if (b && !a) writes.push(() => map.set(id, toYMap(b)));
      else if (a && b) {
        const raw = map.get(id);
        if (!(raw instanceof Y.Map)) {
          writes.push(() => map.set(id, toYMap(b)));
          continue;
        }
        const values = b as unknown as Record<string, unknown>;
        for (const field of changedFields(a, b)) {
          writes.push(() => setOrDelete(raw, field, values[field]));
        }
      }
    }
  }
}

// ── Module helpers ───────────────────────────────────────────────────────────

function parseActor(id: string, raw: unknown): Entry<Actor> {
  const parsed = ActorSchema.safeParse(raw);
  if (!parsed.success) return { issue: `actor "${id}" skipped: ${formatIssues(parsed.error)}` };
  if (parsed.data.id !== id)
    return { issue: `actor "${id}" skipped: its id is "${parsed.data.id}"` };
  return { value: deepFreeze(parsed.data) };
}

function parseNode(id: string, raw: unknown): Entry<BoardNode> {
  if (!(raw instanceof Y.Map)) return { issue: `node "${id}" skipped: not a map` };
  if (!IdSchema.safeParse(id).success) return { issue: `node "${id}" skipped: invalid id` };
  const parsed = NodeSchema.safeParse(raw.toJSON());
  if (!parsed.success) return { issue: `node "${id}" skipped: ${formatIssues(parsed.error)}` };
  if (parsed.data.id !== id)
    return { issue: `node "${id}" skipped: its id field is "${parsed.data.id}"` };
  return { value: deepFreeze(normalizeNode(parsed.data)) };
}

function parseEdge(id: string, raw: unknown): Entry<BoardEdge> {
  if (!(raw instanceof Y.Map)) return { issue: `edge "${id}" skipped: not a map` };
  if (!IdSchema.safeParse(id).success) return { issue: `edge "${id}" skipped: invalid id` };
  const parsed = EdgeSchema.safeParse(raw.toJSON());
  if (!parsed.success) return { issue: `edge "${id}" skipped: ${formatIssues(parsed.error)}` };
  if (parsed.data.id !== id)
    return { issue: `edge "${id}" skipped: its id field is "${parsed.data.id}"` };
  if (parsed.data.source === parsed.data.target) {
    return { issue: `edge "${id}" skipped: it connects "${parsed.data.source}" to itself` };
  }
  return { value: deepFreeze(normalizeEdge(parsed.data)) };
}

function describe(
  before: BoardNode | BoardEdge | undefined,
  after: BoardNode | BoardEdge | undefined,
  what: 'node' | 'edge',
): ChangeKind | null {
  if (!before && after) return `${what}_added`;
  if (before && !after) return `${what}_removed`;
  if (!before || !after) return null;
  const fields = changedFields(before, after);
  if (fields.length === 0) return null;
  if (what === 'node' && fields.every((field) => field === 'view')) return 'node_moved';
  return `${what}_updated`;
}

function withFields(
  change: DocChange,
  before: BoardNode | BoardEdge | undefined,
  after: BoardNode | BoardEdge | undefined,
): DocChange {
  if (change.kind !== 'node_updated' && change.kind !== 'edge_updated') return change;
  if (!before || !after) return change;
  const fields = changedFields(before, after).filter((field) => !BOOKKEEPING_FIELDS.has(field));
  return fields.length > 0 ? { ...change, fields } : change;
}

function toYMap(value: object): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined) map.set(key, cloneJson(field));
  }
  return map;
}

function setOrDelete(map: Y.Map<unknown>, key: string, value: unknown): void {
  if (value === undefined) map.delete(key);
  else map.set(key, cloneJson(value));
}

/** Plan writes that make `map` hold exactly `desired`, including deleting extra keys. */
function planExact(
  map: Y.Map<unknown>,
  desired: Record<string, unknown>,
  writes: Array<() => void>,
): void {
  for (const key of map.keys()) {
    if (desired[key] === undefined) writes.push(() => map.delete(key));
  }
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    const current = map.get(key);
    if (current instanceof Y.AbstractType || !jsonEqual(current, value)) {
      writes.push(() => map.set(key, cloneJson(value)));
    }
  }
}

function unionKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}
