/**
 * The live board: a Yjs document with the layout described in
 * docs/ARCHITECTURE.md ("The board document").
 *
 *   meta    Y.Map   schemaVersion, id, name, description, createdAt, updatedAt
 *   actors  Y.Map   plain actor objects by id
 *   nodes   Y.Map   one Y.Map per node, one key per field, plain JSON values
 *   edges   Y.Map   one Y.Map per edge, same shape
 *   proposals  Y.Map   plain `Proposal` objects by id
 *   asks       Y.Map   plain `Ask` objects by id
 *   comments   Y.Map   plain `Comment` objects by id
 *   claims     Y.Map   plain `Claim` objects by node id
 *
 * `BoardDoc` is the only code that reads or writes these maps. It keeps a
 * parsed copy of every entry, refreshed after each transaction, so reads are
 * cheap and change events can be derived by comparing old and new values.
 * Entries written by a misbehaving peer that fail validation are skipped and
 * reported through `issues()` rather than thrown.
 */
import * as Y from 'yjs';
import type { z } from 'zod';
import type { ChangeKind } from './api.js';
import { OpenBoardError } from './api.js';
import { type ApplyContext, type ApplyOutcome, applyOps } from './apply.js';
import { type Ask, AskSchema, type Proposal, ProposalSchema } from './collab.js';
import { type Claim, ClaimSchema } from './live.js';
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
  type Comment,
  CommentSchema,
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

/** An item's state before and after a transaction; null means absent. */
export interface ItemState<T> {
  before: T | null;
  after: T | null;
}

/**
 * Exact states of the nodes, edges and comments a transaction changed, as
 * stored (bookkeeping fields included, no repairs applied). Only items whose
 * state differs are listed.
 */
export interface DocStates {
  nodes: Record<string, ItemState<BoardNode>>;
  edges: Record<string, ItemState<BoardEdge>>;
  comments: Record<string, ItemState<Comment>>;
  /** Actor registry entries that changed. */
  actors?: Record<string, ItemState<Actor>>;
  /** Board metadata, when it changed. */
  meta?: { before: BoardMeta; after: BoardMeta };
}

/** Everything one transaction changed. */
export interface DocEvent {
  /** Node and edge changes. Comments, proposals and questions are listed by id below. */
  changes: DocChange[];
  /** The transaction's origin, or null when it was not a `TxOrigin` (for example a sync provider). */
  origin: TxOrigin | null;
  /** True when the transaction was made on this replica, false when it arrived from a peer. */
  local: boolean;
  /** True when board metadata or the actor registry changed. */
  metaChanged: boolean;
  /** Ids of proposals whose stored value changed (added, updated or removed). */
  proposals?: string[];
  /** Ids of questions whose stored value changed. */
  asks?: string[];
  /** Ids of comments whose stored value changed. */
  comments?: string[];
  /** Node ids whose claim changed. */
  claims?: string[];
  /**
   * Before and after states of everything in the board JSON that changed:
   * nodes, edges, comments, actors, metadata. Set whenever any of them did.
   */
  states?: DocStates;
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
  proposals: Set<string>;
  asks: Set<string>;
  comments: Set<string>;
  claims: Set<string>;
}

/** What `restore` sets: each listed item to exactly this state, null meaning absent. */
export interface RestoreItems {
  nodes?: Record<string, BoardNode | null>;
  edges?: Record<string, BoardEdge | null>;
  comments?: Record<string, Comment | null>;
}

type Entry<T> = { value: T } | { issue: string };

export class BoardDoc {
  readonly ydoc: Y.Doc;
  private readonly metaMap: Y.Map<unknown>;
  private readonly actorsMap: Y.Map<unknown>;
  private readonly nodesMap: Y.Map<unknown>;
  private readonly edgesMap: Y.Map<unknown>;
  private readonly proposalsMap: Y.Map<unknown>;
  private readonly asksMap: Y.Map<unknown>;
  private readonly commentsMap: Y.Map<unknown>;
  private readonly claimsMap: Y.Map<unknown>;

  private metaState: { meta: BoardMeta; issues: string[]; ready: boolean };
  private readonly actorCache = new Map<string, Actor>();
  private readonly nodeCache = new Map<string, BoardNode>();
  private readonly edgeCache = new Map<string, BoardEdge>();
  private readonly proposalCache = new Map<string, Proposal>();
  private readonly askCache = new Map<string, Ask>();
  private readonly commentCache = new Map<string, Comment>();
  private readonly claimCache = new Map<string, Claim>();
  /** Problems with individual entries, keyed by `<collection>/<id>`, e.g. `nodes/n_1`. */
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
    this.proposalsMap = ydoc.getMap('proposals');
    this.asksMap = ydoc.getMap('asks');
    this.commentsMap = ydoc.getMap('comments');
    this.claimsMap = ydoc.getMap('claims');

    this.metaState = this.readMeta();
    for (const id of this.actorsMap.keys()) this.refreshActor(id);
    for (const id of this.nodesMap.keys()) this.refreshNode(id);
    for (const id of this.edgesMap.keys()) this.refreshEdge(id);
    for (const id of this.proposalsMap.keys()) this.refreshPlain('proposals', id);
    for (const id of this.asksMap.keys()) this.refreshPlain('asks', id);
    for (const id of this.commentsMap.keys()) this.refreshPlain('comments', id);
    for (const id of this.claimsMap.keys()) this.refreshClaim(id);

    this.watch(this.metaMap, (touched) => {
      touched.meta = true;
    });
    this.watch(this.actorsMap, (touched, id) => touched.actors.add(id));
    this.watch(this.nodesMap, (touched, id) => touched.nodes.add(id));
    this.watch(this.edgesMap, (touched, id) => touched.edges.add(id));
    this.watch(this.proposalsMap, (touched, id) => touched.proposals.add(id));
    this.watch(this.asksMap, (touched, id) => touched.asks.add(id));
    this.watch(this.commentsMap, (touched, id) => touched.comments.add(id));
    this.watch(this.claimsMap, (touched, id) => touched.claims.add(id));
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

  /**
   * A node exactly as stored, bookkeeping included and without the repairs
   * `getNode` applies (a dangling `parent` is kept). Used to compare against
   * recorded history.
   */
  storedNode(id: string): BoardNode | undefined {
    return this.nodeCache.get(id);
  }

  /** An edge exactly as stored, even when an endpoint is missing. */
  storedEdge(id: string): BoardEdge | undefined {
    return this.edgeCache.get(id);
  }

  /** Every valid proposal, oldest first (by `createdAt`, then id). */
  proposals(): Proposal[] {
    return sortByCreated([...this.proposalCache.values()]);
  }

  getProposal(id: string): Proposal | undefined {
    return this.proposalCache.get(id);
  }

  /** Every valid question, oldest first. */
  asks(): Ask[] {
    return sortByCreated([...this.askCache.values()]);
  }

  getAsk(id: string): Ask | undefined {
    return this.askCache.get(id);
  }

  /** Every valid comment, oldest first. */
  comments(): Comment[] {
    return sortByCreated([...this.commentCache.values()]);
  }

  getComment(id: string): Comment | undefined {
    return this.commentCache.get(id);
  }

  /** Every valid claim, expired ones included (callers compare `until` with their clock), by node id. */
  claims(): Claim[] {
    return [...this.claimCache.values()].sort((a, b) => compareStrings(a.nodeId, b.nodeId));
  }

  getClaim(nodeId: string): Claim | undefined {
    return this.claimCache.get(nodeId);
  }

  /**
   * The board JSON exactly as stored: every valid entry, with none of the
   * repairs `toJSON()` makes (dangling parents and edges are kept). Building a
   * document from it and calling `toJSON()` gives the same as `toJSON()` here.
   */
  raw(): Board {
    const sortedRecord = <T>(cache: Map<string, T>): Record<string, T> => {
      const out: Record<string, T> = {};
      for (const id of [...cache.keys()].sort(compareStrings)) out[id] = cache.get(id) as T;
      return out;
    };
    const board: Board = {
      schemaVersion: SCHEMA_VERSION,
      ...this.metaState.meta,
      actors: sortedRecord(this.actorCache),
      nodes: sortedRecord(this.nodeCache),
      edges: sortedRecord(this.edgeCache),
    };
    if (this.commentCache.size > 0) board.comments = sortedRecord(this.commentCache);
    return board;
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
    const out: Board = {
      ...board,
      actors: { ...board.actors },
      nodes: { ...board.nodes },
      edges: { ...board.edges },
    };
    if (board.comments) out.comments = { ...board.comments };
    return out;
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

  // ── Proposals, questions, comments ─────────────────────────────────────────

  /** Store a proposal (replacing one with the same id). Throws `invalid_request` when it fails its schema. */
  putProposal(proposal: Proposal, origin: TxOrigin): void {
    this.putPlain(this.proposalsMap, ProposalSchema, proposal, 'proposal', origin);
  }

  /**
   * Add `actor` to the board's actor registry (or update its name), so readers
   * can label what it did. Returns false when it was already there as is.
   */
  registerActor(actor: Actor, origin: TxOrigin): boolean {
    const parsed = ActorSchema.safeParse(actor);
    if (!parsed.success) {
      throw new OpenBoardError('invalid_request', `invalid actor: ${formatIssues(parsed.error)}`);
    }
    if (jsonEqual(this.actorsMap.get(parsed.data.id), parsed.data)) return false;
    this.ydoc.transact(() => this.actorsMap.set(parsed.data.id, cloneJson(parsed.data)), origin);
    return true;
  }

  /** Store a claim (replacing the one on the same node). */
  putClaim(claim: Claim, origin: TxOrigin): void {
    this.putClaims([claim], origin);
  }

  /** Store several claims in one transaction. Throws `invalid_request` when one fails its schema. */
  putClaims(claims: readonly Claim[], origin: TxOrigin): void {
    const parsed = claims.map((claim) => {
      const result = ClaimSchema.safeParse(claim);
      if (!result.success) {
        throw new OpenBoardError('invalid_request', `invalid claim: ${formatIssues(result.error)}`);
      }
      return result.data;
    });
    const changed = parsed.filter((claim) => !jsonEqual(this.claimsMap.get(claim.nodeId), claim));
    if (changed.length === 0) return;
    this.ydoc.transact(() => {
      for (const claim of changed) this.claimsMap.set(claim.nodeId, cloneJson(claim));
    }, origin);
  }

  /** Remove the claims on these nodes in one transaction. Returns the node ids that had one. */
  deleteClaims(nodeIds: readonly string[], origin: TxOrigin): string[] {
    const present = nodeIds.filter((id) => this.claimsMap.has(id));
    if (present.length > 0) {
      this.ydoc.transact(() => {
        for (const id of present) this.claimsMap.delete(id);
      }, origin);
    }
    return present;
  }

  /** Remove a proposal. Returns false when there was none. */
  deleteProposal(id: string, origin: TxOrigin): boolean {
    return this.deletePlain(this.proposalsMap, id, origin);
  }

  /** Store a question (replacing one with the same id). */
  putAsk(ask: Ask, origin: TxOrigin): void {
    this.putPlain(this.asksMap, AskSchema, ask, 'question', origin);
  }

  /**
   * Store a comment (replacing one with the same id). With `actor`, the
   * author is also added to the board's actor registry in the same
   * transaction, so readers can label it.
   */
  putComment(comment: Comment, origin: TxOrigin, opts?: { actor?: Actor }): void {
    const actor = opts?.actor === undefined ? undefined : ActorSchema.safeParse(opts.actor);
    if (actor && !actor.success) {
      throw new OpenBoardError('invalid_request', `invalid actor: ${formatIssues(actor.error)}`);
    }
    this.ydoc.transact(() => {
      if (actor?.success && !jsonEqual(this.actorsMap.get(actor.data.id), actor.data)) {
        this.actorsMap.set(actor.data.id, cloneJson(actor.data));
      }
      this.putPlain(this.commentsMap, CommentSchema, comment, 'comment', origin);
    }, origin);
  }

  /** Remove one comment (not its replies). Returns false when there was none. */
  deleteComment(id: string, origin: TxOrigin): boolean {
    return this.deletePlain(this.commentsMap, id, origin);
  }

  /**
   * Set each listed node, edge and comment to exactly the given state (null:
   * absent), bookkeeping fields included, in one transaction tagged `origin`.
   * Only fields that differ are written; nothing is written when everything
   * already matches. This is the primitive behind exact undo: it does not
   * check semantic rules, so the caller restores consistent sets.
   *
   * Throws `invalid_request` when a value fails its schema or its id does not
   * match its key.
   */
  restore(items: RestoreItems, origin: TxOrigin): AppliedOps {
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
    const plan = (
      what: 'node' | 'edge',
      map: Y.Map<unknown>,
      cache: Map<string, unknown>,
      desired: Record<string, BoardNode | BoardEdge | null>,
      added: string[],
      updated: string[],
      removed: string[],
    ) => {
      const schema = what === 'node' ? NodeSchema : EdgeSchema;
      for (const [id, value] of Object.entries(desired)) {
        const raw = map.get(id);
        if (value === null) {
          if (raw === undefined) continue;
          writes.push(() => map.delete(id));
          if (cache.has(id)) removed.push(id);
          continue;
        }
        const parsed = schema.safeParse(value);
        if (!parsed.success) {
          throw new OpenBoardError(
            'invalid_request',
            `cannot restore ${what} "${id}": ${formatIssues(parsed.error)}`,
          );
        }
        if (parsed.data.id !== id) {
          throw new OpenBoardError(
            'invalid_request',
            `cannot restore ${what} "${id}": its id field is "${parsed.data.id}"`,
          );
        }
        if (raw instanceof Y.Map) {
          const before = writes.length;
          planExact(raw, value as unknown as Record<string, unknown>, writes);
          if (writes.length > before) (cache.has(id) ? updated : added).push(id);
        } else {
          writes.push(() => map.set(id, toYMap(value)));
          (cache.has(id) ? updated : added).push(id);
        }
      }
    };
    plan(
      'node',
      this.nodesMap,
      this.nodeCache,
      items.nodes ?? {},
      applied.addedNodes,
      applied.updatedNodes,
      applied.removedNodes,
    );
    plan(
      'edge',
      this.edgesMap,
      this.edgeCache,
      items.edges ?? {},
      applied.addedEdges,
      applied.updatedEdges,
      applied.removedEdges,
    );
    for (const [id, value] of Object.entries(items.comments ?? {})) {
      if (value === null) {
        if (this.commentsMap.has(id)) writes.push(() => this.commentsMap.delete(id));
        continue;
      }
      const parsed = CommentSchema.safeParse(value);
      if (!parsed.success || parsed.data.id !== id) {
        throw new OpenBoardError('invalid_request', `cannot restore comment "${id}"`);
      }
      if (!jsonEqual(this.commentsMap.get(id), value)) {
        writes.push(() => this.commentsMap.set(id, cloneJson(value)));
      }
    }
    if (writes.length > 0) {
      this.ydoc.transact(() => {
        for (const write of writes) write();
      }, origin);
    }
    return applied;
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

    const comments = target.comments ?? {};
    for (const id of this.commentsMap.keys()) {
      if (!(id in comments)) writes.push(() => this.commentsMap.delete(id));
    }
    for (const [id, comment] of Object.entries(comments)) {
      if (!jsonEqual(this.commentsMap.get(id), comment))
        writes.push(() => this.commentsMap.set(id, cloneJson(comment)));
    }

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
        touched = {
          meta: false,
          actors: new Set(),
          nodes: new Set(),
          edges: new Set(),
          proposals: new Set(),
          asks: new Set(),
          comments: new Set(),
          claims: new Set(),
        };
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
    let metaState: DocStates['meta'];
    if (touched.meta) {
      const previous = this.metaState;
      this.metaState = this.readMeta();
      metaChanged =
        !jsonEqual(previous.meta, this.metaState.meta) || previous.ready !== this.metaState.ready;
      if (!jsonEqual(previous.meta, this.metaState.meta)) {
        metaState = { before: previous.meta, after: this.metaState.meta };
      }
    }
    const actorStates: Record<string, ItemState<Actor>> = {};
    for (const id of touched.actors) {
      const previous = this.actorCache.get(id);
      this.refreshActor(id);
      const current = this.actorCache.get(id);
      if (!jsonEqual(previous, current)) {
        metaChanged = true;
        actorStates[id] = { before: previous ?? null, after: current ?? null };
      }
    }
    const oldClaims = new Map<string, Claim | undefined>();
    for (const id of touched.claims) oldClaims.set(id, this.claimCache.get(id));
    for (const id of touched.claims) this.refreshClaim(id);
    const claims = changedIds(oldClaims, this.claimCache);
    const oldComments = new Map<string, Comment | undefined>();
    for (const id of touched.comments) oldComments.set(id, this.commentCache.get(id));
    const oldProposals = new Map<string, Proposal | undefined>();
    for (const id of touched.proposals) oldProposals.set(id, this.proposalCache.get(id));
    const oldAsks = new Map<string, Ask | undefined>();
    for (const id of touched.asks) oldAsks.set(id, this.askCache.get(id));

    for (const id of touched.nodes) this.refreshNode(id);
    for (const id of touched.edges) this.refreshEdge(id);
    for (const id of touched.proposals) this.refreshPlain('proposals', id);
    for (const id of touched.asks) this.refreshPlain('asks', id);
    for (const id of touched.comments) this.refreshPlain('comments', id);

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

    const states: DocStates = { nodes: {}, edges: {}, comments: {} };
    for (const [id, before] of oldNodes) {
      const after = this.nodeCache.get(id);
      if (!jsonEqual(before, after))
        states.nodes[id] = { before: before ?? null, after: after ?? null };
    }
    for (const [id, before] of oldEdges) {
      const after = this.edgeCache.get(id);
      if (!jsonEqual(before, after))
        states.edges[id] = { before: before ?? null, after: after ?? null };
    }
    const comments = changedIds(oldComments, this.commentCache);
    for (const id of comments) {
      states.comments[id] = {
        before: oldComments.get(id) ?? null,
        after: this.commentCache.get(id) ?? null,
      };
    }
    const proposals = changedIds(oldProposals, this.proposalCache);
    const asks = changedIds(oldAsks, this.askCache);

    if (Object.keys(actorStates).length > 0) states.actors = actorStates;
    if (metaState) states.meta = metaState;
    const itemsChanged =
      Object.keys(states.nodes).length +
        Object.keys(states.edges).length +
        comments.length +
        Object.keys(actorStates).length >
        0 || metaState !== undefined;
    if (
      changes.length === 0 &&
      !metaChanged &&
      !itemsChanged &&
      proposals.length === 0 &&
      asks.length === 0 &&
      claims.length === 0
    ) {
      return;
    }
    const event: DocEvent = { changes, origin: this.originOf(tr), local: tr.local, metaChanged };
    if (proposals.length > 0) event.proposals = proposals;
    if (asks.length > 0) event.asks = asks;
    if (comments.length > 0) event.comments = comments;
    if (claims.length > 0) event.claims = claims;
    if (itemsChanged) event.states = states;
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

  private refreshPlain(collection: 'proposals' | 'asks' | 'comments', id: string): void {
    const key = `${collection}/${id}`;
    if (collection === 'proposals') {
      const raw = this.proposalsMap.get(id);
      this.store(
        this.proposalCache,
        key,
        raw === undefined ? null : parsePlain(ProposalSchema, 'proposal', id, raw),
      );
    } else if (collection === 'asks') {
      const raw = this.asksMap.get(id);
      this.store(
        this.askCache,
        key,
        raw === undefined ? null : parsePlain(AskSchema, 'question', id, raw),
      );
    } else {
      const raw = this.commentsMap.get(id);
      this.store(
        this.commentCache,
        key,
        raw === undefined ? null : parsePlain(CommentSchema, 'comment', id, raw),
      );
    }
  }

  private refreshClaim(nodeId: string): void {
    const raw = this.claimsMap.get(nodeId);
    let entry: Entry<Claim> | null = null;
    if (raw !== undefined) {
      const parsed = ClaimSchema.safeParse(raw instanceof Y.AbstractType ? raw.toJSON() : raw);
      if (!parsed.success) {
        entry = { issue: `claim on "${nodeId}" skipped: ${formatIssues(parsed.error)}` };
      } else if (parsed.data.nodeId !== nodeId) {
        entry = { issue: `claim on "${nodeId}" skipped: it names node "${parsed.data.nodeId}"` };
      } else entry = { value: deepFreeze(parsed.data) };
    }
    this.store(this.claimCache, `claims/${nodeId}`, entry);
  }

  private putPlain<T extends { id: string }>(
    map: Y.Map<unknown>,
    schema: z.ZodType<T>,
    value: T,
    what: string,
    origin: TxOrigin,
  ): void {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new OpenBoardError('invalid_request', `invalid ${what}: ${formatIssues(parsed.error)}`);
    }
    if (!IdSchema.safeParse(parsed.data.id).success) {
      throw new OpenBoardError('invalid_request', `invalid ${what} id`);
    }
    if (jsonEqual(map.get(parsed.data.id), parsed.data)) return;
    this.ydoc.transact(() => map.set(parsed.data.id, cloneJson(parsed.data)), origin);
  }

  private deletePlain(map: Y.Map<unknown>, id: string, origin: TxOrigin): boolean {
    if (!map.has(id)) return false;
    this.ydoc.transact(() => map.delete(id), origin);
    return true;
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
    if (this.commentCache.size > 0) {
      const comments: Record<string, Comment> = {};
      for (const id of [...this.commentCache.keys()].sort(compareStrings)) {
        comments[id] = this.commentCache.get(id) as Comment;
      }
      board.comments = comments;
    }
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

function parsePlain<T extends { id: string }>(
  schema: z.ZodType<T>,
  what: string,
  id: string,
  raw: unknown,
): Entry<T> {
  const value = raw instanceof Y.AbstractType ? (raw.toJSON() as unknown) : raw;
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { issue: `${what} "${id}" skipped: ${formatIssues(parsed.error)}` };
  if (parsed.data.id !== id)
    return { issue: `${what} "${id}" skipped: its id field is "${parsed.data.id}"` };
  return { value: deepFreeze(parsed.data) };
}

function changedIds<T>(before: Map<string, T | undefined>, now: Map<string, T>): string[] {
  const out: string[] = [];
  for (const [id, value] of before) if (!jsonEqual(value, now.get(id))) out.push(id);
  return out.sort(compareStrings);
}

function sortByCreated<T extends { id: string; createdAt: string }>(items: T[]): T[] {
  return items.sort(
    (a, b) => compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id),
  );
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
