/**
 * One live board: its document, the store that persists it, its change feed,
 * its history and inbox, and the presence of everyone connected to it.
 *
 * Every transaction on the document, from any path (the agent API, a browser
 * over sync, a file reload), passes one observer here, which numbers it in the
 * change feed, records it in the history, and turns comments and answers into
 * inbox items.
 */
import {
  type Actor,
  ActorSchema,
  type Ask,
  type Batch,
  BoardDoc,
  type Comment,
  type DocEvent,
  MENTION_AGENTS,
  newId,
  type Op,
  type Presence,
  type TxOrigin,
} from '@openboard/core';
import { Awareness } from 'y-protocols/awareness';
import { ConfigStore } from './config.js';
import { ChangeFeed } from './feed.js';
import { errorMessage, readIfExists, writeFileAtomic } from './fsutil.js';
import { History, type TxContext } from './history.js';
import { Inbox } from './inbox.js';
import { Mutex } from './mutex.js';
import { BoardStore, type FileStatus, loadBoard, type StoreFiles } from './store.js';

export interface RoomFiles extends StoreFiles {
  changes: string;
  history: string;
  inbox: string;
  /** The document lineage, next to the `.ydoc` snapshot it belongs to. */
  lineage: string;
}

export interface RoomOptions {
  log?: (line: string) => void;
  debounceMs?: number;
  /** Project settings shared by every board; a private default store when omitted. */
  config?: ConfigStore;
  /** Called (debounced) when nodes or edges that pending proposals touch have changed. */
  onProposalsStale?: (room: Room) => Promise<void>;
  /** Milliseconds since the epoch; injectable for tests. */
  clock?: () => number;
  /**
   * Called after a batch that changed nodes or edges, once the write that made
   * it (an apply with its layout, an undo, a decision) has finished. Browser
   * edits are reported once they pause; a batch that keeps growing (coalesced
   * edits by one person) is reported again each time.
   */
  onBatch?: (room: Room, batch: Batch) => void;
}

/** Quiet time after a batch's last transaction before it is reported to `onBatch`. */
const BATCH_REPORT_MS = 30;

/** A human's current selection, as published over awareness. */
export interface HumanSelection {
  by: Actor;
  nodeIds: string[];
  edgeIds: string[];
  at: string;
}

const REFRESH_DELAY_MS = 50;

export class Room {
  readonly awareness: Awareness;
  /** Serializes agent writes (apply, layout, decisions, undo) on this board. */
  readonly lock = new Mutex();
  /** Actors seen on this board's connections and sessions, for labelling the change feed. */
  readonly knownActors = new Map<string, Actor>();
  readonly config: ConfigStore;
  private readonly detachDoc: () => void;
  private context: TxContext | null = null;
  private readonly askStatus = new Map<string, Ask['status']>();
  private readonly askWaiters = new Map<string, Set<() => void>>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly batchTimers = new Map<string, NodeJS.Timeout>();
  /** Browser connections currently syncing this board. */
  viewers = 0;
  private closed = false;
  private readonly log: (line: string) => void;

  private constructor(
    readonly id: string,
    /**
     * Random id of this live document, made when it was created or rebuilt
     * from the board file. A browser must present it to sync, so a tab holding
     * a document from another lineage cannot merge it into this one.
     */
    readonly lineage: string,
    readonly doc: BoardDoc,
    readonly store: BoardStore,
    readonly feed: ChangeFeed,
    readonly history: History,
    readonly inbox: Inbox,
    private readonly opts: RoomOptions,
  ) {
    this.log = opts.log ?? (() => {});
    this.config = opts.config ?? new ConfigStore('', this.log);
    this.awareness = new Awareness(doc.ydoc);
    // The server itself has no presence; only connected clients do.
    this.awareness.setLocalState(null);
    for (const ask of doc.asks()) this.askStatus.set(ask.id, ask.status);
    this.detachDoc = doc.observe((event) => this.observe(event));
  }

  /** Open a board that exists on disk, or return null when it does not. */
  static async open(id: string, files: RoomFiles, opts: RoomOptions = {}): Promise<Room | null> {
    const loaded = await loadBoard(files);
    if (!loaded) return null;
    const lineage = await lineageFor(files.lineage, loaded.restored);
    const feed = await ChangeFeed.open(files.changes, { log: opts.log });
    const history = await History.open(files.history, { log: opts.log, lineage });
    const inbox = await Inbox.open(files.inbox, { log: opts.log });
    const store = new BoardStore(loaded.doc, files, loaded, opts);
    const room = new Room(id, lineage, loaded.doc, store, feed, history, inbox, opts);
    // The file changed while the server was not running: catch up, and let the
    // feed and history record what changed.
    if (loaded.reconcileTo) loaded.doc.reconcile(loaded.reconcileTo, room.fileOrigin);
    return room;
  }

  /** Start a new board around `doc` and write it to disk right away. */
  static async create(
    id: string,
    doc: BoardDoc,
    files: RoomFiles,
    opts: RoomOptions = {},
  ): Promise<Room> {
    await BoardStore.discardSnapshot(files);
    const lineage = await lineageFor(files.lineage, false);
    const feed = await ChangeFeed.open(files.changes, { log: opts.log });
    const history = await History.open(files.history, { log: opts.log, lineage });
    const inbox = await Inbox.open(files.inbox, { log: opts.log });
    const store = new BoardStore(doc, files, { fileText: null }, opts);
    const room = new Room(id, lineage, doc, store, feed, history, inbox, opts);
    await store.writeNow();
    return room;
  }

  get cursor(): number {
    return this.feed.cursor;
  }

  get fileStatus(): FileStatus {
    return this.store.fileStatus;
  }

  private get fileOrigin(): TxOrigin {
    return this.doc.origin('system', 'file');
  }

  /**
   * Run `write` (which makes at most a few transactions) with `context`
   * attached to them, so the history and the feed know the batch id, reason,
   * proposal or undone batch.
   */
  withContext<T>(context: TxContext, write: () => T): T {
    const previous = this.context;
    this.context = context;
    try {
      return write();
    } finally {
      this.context = previous;
    }
  }

  /** Actor labels for rendering: the board's registry plus everyone seen live. */
  actors(): Record<string, Actor> {
    return { ...Object.fromEntries(this.knownActors), ...this.doc.toJSON().actors };
  }

  /** The actor with this id, as far as the board knows it. */
  actorFor(id: string): Actor {
    return this.actors()[id] ?? { id, kind: 'agent', name: id };
  }

  /**
   * Agents that have acted on this board: authors in its registry, plus agents
   * seen live that have history, proposals, questions or comments here.
   */
  agentIds(): string[] {
    const registry = this.doc.toJSON().actors;
    const ids = new Set(
      Object.values(registry)
        .filter((actor) => actor.kind === 'agent')
        .map((actor) => actor.id),
    );
    const acted = new Set<string>();
    for (const record of this.history.all()) acted.add(record.batch.actor);
    for (const p of this.doc.proposals()) acted.add(p.author);
    for (const a of this.doc.asks()) acted.add(a.author);
    for (const c of this.doc.comments()) acted.add(c.author);
    for (const actor of this.knownActors.values()) {
      if (actor.kind === 'agent' && acted.has(actor.id)) ids.add(actor.id);
    }
    return [...ids].sort();
  }

  /** The most recent non-empty selection published by a human, or null. */
  humanSelection(): HumanSelection | null {
    let best: HumanSelection | null = null;
    for (const state of this.awareness.getStates().values()) {
      const selection = readSelection(state);
      if (selection && (!best || selection.at > best.at)) best = selection;
    }
    return best;
  }

  /**
   * Resolve once the question is no longer open, after `ms`, when `signal`
   * aborts, or when the room closes, whichever comes first. Never rejects.
   */
  waitForAsk(askId: string, ms: number, signal?: AbortSignal): Promise<void> {
    if (this.closed || this.doc.getAsk(askId)?.status !== 'open' || ms <= 0 || signal?.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let waiters = this.askWaiters.get(askId);
      if (!waiters) {
        waiters = new Set();
        this.askWaiters.set(askId, waiters);
      }
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        const set = this.askWaiters.get(askId);
        set?.delete(done);
        if (set?.size === 0) this.askWaiters.delete(askId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
      waiters.add(done);
    });
  }

  /** How many long-polls are waiting on questions; for tests and diagnostics. */
  get waiting(): number {
    let n = 0;
    for (const set of this.askWaiters.values()) n += set.size;
    return n;
  }

  async flush(): Promise<void> {
    await this.store.flush();
    await this.feed.flush();
    await this.history.flush();
    await this.inbox.flush();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const timer of this.batchTimers.values()) clearTimeout(timer);
    this.batchTimers.clear();
    for (const set of [...this.askWaiters.values()]) for (const done of [...set]) done();
    await this.store.close();
    await this.feed.flush();
    await this.history.flush();
    await this.inbox.flush();
    this.detachDoc();
    this.awareness.destroy();
  }

  // ── The observer ───────────────────────────────────────────────────────────

  private observe(event: DocEvent): void {
    const ctx = this.context;
    const pending = this.history.begin(event, ctx);
    const tag: { reason?: string; batchId?: string } = {};
    const reason = pending?.record?.batch.reason ?? ctx?.reason;
    if (reason !== undefined) tag.reason = reason;
    if (pending) tag.batchId = pending.id;
    const from = this.feed.cursor;
    this.feed.record(event, tag);
    if (event.states) this.history.step(event.states, from, this.feed.cursor);
    if (pending) {
      this.history.commit(pending, event, ctx, this.feed.cursor);
      this.scheduleBatchReport(pending.id);
    }

    // A removed node takes its claim with it. Written after this transaction.
    const gone = Object.entries(event.states?.nodes ?? {})
      .filter(([id, state]) => state.after === null && this.doc.getClaim(id))
      .map(([id]) => id);
    if (gone.length > 0) {
      queueMicrotask(() => {
        if (!this.closed) this.doc.deleteClaims(gone, this.doc.origin('system', 'ops'));
      });
    }

    try {
      if (event.comments && event.origin?.source !== 'undo') {
        for (const id of event.comments) {
          const state = event.states?.comments[id];
          if (state && state.before === null && state.after) this.notifyComment(state.after);
        }
      }
      if (event.asks) this.asksChanged(event.asks);
      if (event.states) this.maybeRefresh(event);
    } catch (error) {
      this.log(`board "${this.id}": ${errorMessage(error)}`);
    }
  }

  /**
   * Report a batch to `onBatch` once it has been quiet for a moment and the
   * board's write lock is free, so an apply is reported with its layout.
   */
  private scheduleBatchReport(id: string): void {
    const onBatch = this.opts.onBatch;
    if (!onBatch || this.closed) return;
    const previous = this.batchTimers.get(id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.batchTimers.delete(id);
      void this.lock
        .run(() => undefined)
        .then(() => {
          if (this.closed) return;
          const record = this.history.get(id);
          if (!record || record.batch.nodeIds.length + record.batch.edgeIds.length === 0) return;
          onBatch(this, { ...record.batch });
        })
        .catch((error: unknown) => this.log(`board "${this.id}": ${errorMessage(error)}`));
    }, BATCH_REPORT_MS);
    timer.unref();
    this.batchTimers.set(id, timer);
  }

  private name(id: string): string {
    return this.actors()[id]?.name ?? id;
  }

  private where(comment: Comment): string {
    if (comment.nodeId === undefined) return 'on the board';
    const node = this.doc.storedNode(comment.nodeId);
    return node ? `on ${JSON.stringify(node.title)}` : 'on a removed node';
  }

  private notifyComment(comment: Comment): void {
    const recipients = new Map<string, 'mention' | 'reply'>();
    for (const mention of comment.mentions ?? []) {
      if (mention === MENTION_AGENTS)
        for (const id of this.agentIds()) recipients.set(id, 'mention');
      else if (ActorSchema.shape.id.safeParse(mention).success) recipients.set(mention, 'mention');
    }
    const threadAuthors = new Set(
      this.doc
        .comments()
        .filter((c) => c.thread === comment.thread && c.id !== comment.id)
        .map((c) => c.author),
    );
    for (const author of threadAuthors)
      if (!recipients.has(author)) recipients.set(author, 'reply');
    const node = comment.nodeId === undefined ? undefined : this.doc.storedNode(comment.nodeId);
    if (node && !recipients.has(node.createdBy)) recipients.set(node.createdBy, 'reply');
    recipients.delete(comment.author);

    const from = this.name(comment.author);
    const where = this.where(comment);
    for (const [to, kind] of recipients) {
      let summary: string;
      if (kind === 'mention') summary = `${from} mentioned you ${where}`;
      else if (threadAuthors.has(to))
        summary = `${from} replied in a thread you took part in ${where}`;
      else summary = `${from} commented ${where}, which you created`;
      const item: Parameters<Inbox['deliver']>[1] = {
        kind,
        from: comment.author,
        summary,
        body: comment.body,
        commentId: comment.id,
        thread: comment.thread,
        at: comment.createdAt,
      };
      if (comment.nodeId !== undefined) item.nodeId = comment.nodeId;
      this.inbox.deliver(to, item);
    }
  }

  private asksChanged(ids: string[]): void {
    for (const id of ids) {
      const ask = this.doc.getAsk(id);
      const previous = this.askStatus.get(id);
      if (ask) this.askStatus.set(id, ask.status);
      else this.askStatus.delete(id);
      if (ask && previous !== 'answered' && ask.status === 'answered' && ask.answer) {
        const by = ask.answer.by;
        if (by !== ask.author) {
          const answer = [ask.answer.option, ask.answer.text].filter(Boolean).join(' — ');
          this.inbox.deliver(ask.author, {
            kind: 'answer',
            from: by,
            summary: `${this.name(by)} answered your question ${JSON.stringify(ask.question.slice(0, 80))}`,
            body: answer,
            askId: ask.id,
            at: ask.answer.at,
          });
        }
      }
      if (!ask || ask.status !== 'open') {
        for (const done of [...(this.askWaiters.get(id) ?? [])]) done();
      }
    }
  }

  private maybeRefresh(event: DocEvent): void {
    if (!this.opts.onProposalsStale || this.closed) return;
    const states = event.states;
    if (!states) return;
    const touched = new Set([...Object.keys(states.nodes), ...Object.keys(states.edges)]);
    if (touched.size === 0) return;
    const affected = this.doc
      .proposals()
      .some(
        (p) =>
          p.status === 'pending' &&
          p.items.some((item) => item.status === 'pending' && opTouches(item.op, touched)),
      );
    if (!affected || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.closed) return;
      const refresh = this.opts.onProposalsStale;
      if (!refresh) return;
      this.lock
        .run(() => refresh(this))
        .catch((error: unknown) => this.log(`proposals on "${this.id}": ${errorMessage(error)}`));
    }, REFRESH_DELAY_MS);
  }
}

/** Whether an operation names any of `ids` (its target, parent, or edge ends). */
function opTouches(op: Op, ids: ReadonlySet<string>): boolean {
  const named: string[] = [];
  switch (op.op) {
    case 'add_node':
      if (op.node.parent) named.push(op.node.parent);
      break;
    case 'update_node':
      named.push(op.id);
      if (typeof op.patch.parent === 'string') named.push(op.patch.parent);
      break;
    case 'add_edge':
      named.push(op.edge.source, op.edge.target);
      break;
    default:
      named.push(op.id);
  }
  return named.some((id) => ids.has(id));
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Read a presence state defensively: it comes from a client and may be anything. */
function readSelection(state: unknown): HumanSelection | null {
  if (typeof state !== 'object' || state === null) return null;
  const presence = state as Partial<Record<keyof Presence, unknown>>;
  const actor = ActorSchema.safeParse(presence.actor);
  if (!actor.success || actor.data.kind !== 'human') return null;
  const selection = presence.selection;
  if (typeof selection !== 'object' || selection === null) return null;
  const raw = selection as Record<string, unknown>;
  const nodeIds = stringList(raw.nodeIds);
  const edgeIds = stringList(raw.edgeIds);
  if (nodeIds.length === 0 && edgeIds.length === 0) return null;
  const at = typeof raw.at === 'string' ? raw.at : '';
  return { by: actor.data, nodeIds, edgeIds, at };
}

/** The lineage stored next to a restored snapshot, or a new one (written right away). */
async function lineageFor(file: string, restored: boolean): Promise<string> {
  if (restored) {
    const stored = (await readIfExists(file))?.toString('utf8').trim();
    if (stored && /^[a-z0-9_]{6,64}$/.test(stored)) return stored;
  }
  const lineage = newId('l');
  await writeFileAtomic(file, `${lineage}\n`);
  return lineage;
}
