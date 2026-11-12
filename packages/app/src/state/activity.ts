/**
 * What other people and agents just did to the board, for the person
 * watching: which nodes and edges were recently added or changed (drawn with
 * a short-lived outline and chip), what was removed (a quiet notice), and
 * bursts of changes for follow mode.
 *
 * The rules are pure functions over an `ActivityState` with the time passed
 * in, so they are tested without timers. `ActivityStore` holds the state for
 * one session, feeds it document events, and expires entries on a clock it
 * is given.
 *
 * Attribution: a change made on this replica carries a `TxOrigin`. A change
 * that arrived from the server has no origin (it came through the sync
 * provider), so it is attributed through the entry's own bookkeeping
 * (`createdBy` / `updatedBy`). A removal leaves nothing to read, so the store
 * asks the server's change feed who made it.
 */
import type { Actor, BoardEdge, BoardNode, DocEvent } from '@openboard/core';
import { Emitter } from './emitter.js';

/** How long a change stays highlighted. */
export const HIGHLIGHT_MS = 8000;
/** How long a removal notice stays up (long enough to reach its Undo). */
export const REMOVAL_MS = 12_000;
/** A removal by the same actor within this window joins the notice already shown. */
export const REMOVAL_MERGE_MS = 4000;
/** At most this many removal notices are shown at once; older ones give way. */
export const MAX_REMOVALS = 3;
/**
 * A change that arrives from the server but was made longer ago than this is
 * history (a reconnect catching up, a file reload), not something to point at.
 */
export const MAX_AGE_MS = 2 * 60_000;

export type ItemKind = 'node' | 'edge';
export type ChangeVerb = 'added' | 'updated' | 'commented';

/** One change made by someone else, attributed as well as it can be. */
export interface RemoteChange {
  kind: ItemKind;
  id: string;
  verb: ChangeVerb | 'removed';
  /** Null when the change could not be attributed (yet). */
  actorId: string | null;
  /** Title before removal, for removal notices. */
  title?: string;
  /** The history batch the change belongs to, when known (to undo a removal). */
  batchId?: string;
}

export interface Highlight {
  /** `node:<id>` or `edge:<id>`. */
  key: string;
  kind: ItemKind;
  id: string;
  actorId: string;
  verb: ChangeVerb;
  at: number;
  until: number;
}

export interface RemovalNotice {
  id: number;
  actorId: string | null;
  nodes: number;
  edges: number;
  /** Titles of the removed nodes, first ones first. */
  titles: readonly string[];
  /** History batches that made the removals, when the change feed named them. */
  batchIds?: readonly string[];
  /** Ids of what was removed, for finding the batch through the history. */
  itemIds?: readonly string[];
  at: number;
  until: number;
}

export interface ActivityState {
  highlights: ReadonlyMap<string, Highlight>;
  removals: readonly RemovalNotice[];
  nextId: number;
}

export const EMPTY_ACTIVITY: ActivityState = Object.freeze({
  highlights: new Map<string, Highlight>(),
  removals: [],
  nextId: 1,
});

export function itemKey(kind: ItemKind, id: string): string {
  return `${kind}:${id}`;
}

// ── Classifying document events ──────────────────────────────────────────────

export interface ClassifyContext {
  /** The local actor; their own changes are never highlighted. */
  me: string;
  node(id: string): BoardNode | undefined;
  edge(id: string): BoardEdge | undefined;
  /** False while the document is still catching up on first load. */
  live: boolean;
  now: number;
  maxAgeMs?: number;
}

/** Fields whose change is presentation only (a move, a resize). */
const PRESENTATION_FIELDS: ReadonlySet<string> = new Set(['view']);

/**
 * Turn one document event into the changes worth showing: made by someone
 * else, semantic (not a move), and not the layout engine or a file reload.
 */
export function classify(event: DocEvent, ctx: ClassifyContext): RemoteChange[] {
  if (!ctx.live) return [];
  const origin = event.origin;
  if (origin) {
    if (origin.actorId === ctx.me) return [];
    if (origin.source === 'layout' || origin.source === 'file') return [];
  } else if (event.local) {
    // An untagged local transaction is internal bookkeeping, not anyone's edit.
    return [];
  }
  const maxAge = ctx.maxAgeMs ?? MAX_AGE_MS;
  // Only remote entries need the age check; a tagged transaction happened just now.
  const fresh = (iso: string) => origin !== null || ctx.now - Date.parse(iso) <= maxAge;

  const out: RemoteChange[] = [];
  for (const change of event.changes) {
    const kind: ItemKind = change.kind.startsWith('node_') ? 'node' : 'edge';
    if (change.kind === 'node_moved') continue;
    if (change.kind.endsWith('_removed')) {
      const removed: RemoteChange = {
        kind,
        id: change.id,
        verb: 'removed',
        actorId: origin?.actorId ?? null,
      };
      if (change.title !== undefined && kind === 'node') removed.title = change.title;
      out.push(removed);
      continue;
    }
    const entry = kind === 'node' ? ctx.node(change.id) : ctx.edge(change.id);
    if (!entry) continue;
    if (change.kind.endsWith('_added')) {
      const actorId = origin?.actorId ?? entry.createdBy;
      if (actorId === ctx.me || !fresh(entry.createdAt)) continue;
      out.push({ kind, id: change.id, verb: 'added', actorId });
      continue;
    }
    const fields = change.fields ?? [];
    if (fields.length > 0 && fields.every((f) => PRESENTATION_FIELDS.has(f))) continue;
    const actorId = origin?.actorId ?? entry.updatedBy;
    if (actorId === ctx.me || !fresh(entry.updatedAt)) continue;
    out.push({ kind, id: change.id, verb: 'updated', actorId });
  }
  // A new comment by someone else on a card highlights the card.
  for (const id of event.comments ?? []) {
    const state = event.states?.comments[id];
    const comment = state?.after;
    if (!state || state.before !== null || !comment || comment.nodeId === undefined) continue;
    const actorId = origin?.actorId ?? comment.author;
    if (actorId === ctx.me || !fresh(comment.createdAt) || !ctx.node(comment.nodeId)) continue;
    out.push({ kind: 'node', id: comment.nodeId, verb: 'commented', actorId });
  }
  return out;
}

// ── Reducers ─────────────────────────────────────────────────────────────────

/** Fold attributed changes into the state. Changes by `me` or without an actor never highlight. */
export function receive(
  state: ActivityState,
  changes: readonly RemoteChange[],
  me: string,
  now: number,
): ActivityState {
  if (changes.length === 0) return state;
  // Copied on first write, so an event that changes nothing returns `state` itself.
  const draft: { highlights: Map<string, Highlight> | null; removals: RemovalNotice[] | null } = {
    highlights: null,
    removals: null,
  };
  const current = () => draft.highlights ?? state.highlights;
  const writable = () => {
    draft.highlights ??= new Map(state.highlights);
    return draft.highlights;
  };
  let nextId = state.nextId;

  // Removals are grouped per actor within this batch, then merged into a live notice.
  const removedBy = new Map<
    string | null,
    { nodes: number; edges: number; titles: string[]; batchIds: string[]; itemIds: string[] }
  >();

  for (const change of changes) {
    const key = itemKey(change.kind, change.id);
    if (change.verb === 'removed') {
      if (current().has(key)) writable().delete(key);
      if (change.actorId === me) continue;
      const group = removedBy.get(change.actorId) ?? {
        nodes: 0,
        edges: 0,
        titles: [],
        batchIds: [],
        itemIds: [],
      };
      group.itemIds.push(change.id);
      if (change.batchId && !group.batchIds.includes(change.batchId))
        group.batchIds.push(change.batchId);
      if (change.kind === 'node') {
        group.nodes++;
        if (change.title) group.titles.push(change.title);
      } else group.edges++;
      removedBy.set(change.actorId, group);
      continue;
    }
    if (change.actorId === null || change.actorId === me) continue;
    const previous = current().get(key);
    // "added" stays "added" while it is still highlighted, even if it is edited again.
    const verb: ChangeVerb =
      previous?.verb === 'added' && previous.actorId === change.actorId ? 'added' : change.verb;
    writable().set(key, {
      key,
      kind: change.kind,
      id: change.id,
      actorId: change.actorId,
      verb,
      at: now,
      until: now + HIGHLIGHT_MS,
    });
  }

  if (removedBy.size > 0) {
    let removals = [...state.removals];
    for (const [actorId, group] of removedBy) {
      const index = removals.findIndex(
        (notice) => notice.actorId === actorId && now - notice.at <= REMOVAL_MERGE_MS,
      );
      const existing = index >= 0 ? removals[index] : undefined;
      if (existing) {
        const merged: RemovalNotice = {
          ...existing,
          nodes: existing.nodes + group.nodes,
          edges: existing.edges + group.edges,
          titles: [...existing.titles, ...group.titles],
          at: now,
          until: now + REMOVAL_MS,
        };
        const batchIds = [...new Set([...(existing.batchIds ?? []), ...group.batchIds])];
        if (batchIds.length > 0) merged.batchIds = batchIds;
        merged.itemIds = [...(existing.itemIds ?? []), ...group.itemIds];
        removals[index] = merged;
      } else {
        const notice: RemovalNotice = {
          id: nextId++,
          actorId,
          nodes: group.nodes,
          edges: group.edges,
          titles: group.titles,
          itemIds: group.itemIds,
          at: now,
          until: now + REMOVAL_MS,
        };
        if (group.batchIds.length > 0) notice.batchIds = group.batchIds;
        removals.push(notice);
      }
    }
    if (removals.length > MAX_REMOVALS) removals = removals.slice(-MAX_REMOVALS);
    draft.removals = removals;
  }

  const { highlights, removals } = draft;
  if (highlights === null && removals === null) return state;
  return {
    highlights: highlights ?? state.highlights,
    removals: removals ?? state.removals,
    nextId,
  };
}

/** Drop what has run out. Returns `state` itself when nothing did. */
export function expire(state: ActivityState, now: number): ActivityState {
  let highlights: Map<string, Highlight> | null = null;
  for (const [key, h] of state.highlights) {
    if (h.until > now) continue;
    highlights ??= new Map(state.highlights);
    highlights.delete(key);
  }
  const removals = state.removals.filter((r) => r.until > now);
  const removalsChanged = removals.length !== state.removals.length;
  if (highlights === null && !removalsChanged) return state;
  return {
    highlights: highlights ?? state.highlights,
    removals: removalsChanged ? removals : state.removals,
    nextId: state.nextId,
  };
}

/** Drop the highlights of these entries (they are gone). */
export function forget(
  state: ActivityState,
  items: Iterable<{ kind: ItemKind; id: string }>,
): ActivityState {
  let highlights: Map<string, Highlight> | null = null;
  for (const { kind, id } of items) {
    const key = itemKey(kind, id);
    if (!state.highlights.has(key)) continue;
    highlights ??= new Map(state.highlights);
    highlights.delete(key);
  }
  return highlights ? { ...state, highlights } : state;
}

export function dismissRemoval(state: ActivityState, id: number): ActivityState {
  if (!state.removals.some((r) => r.id === id)) return state;
  return { ...state, removals: state.removals.filter((r) => r.id !== id) };
}

/** When the next entry runs out, or null when nothing is pending. */
export function nextExpiry(state: ActivityState): number | null {
  let next = Number.POSITIVE_INFINITY;
  for (const h of state.highlights.values()) next = Math.min(next, h.until);
  for (const r of state.removals) next = Math.min(next, r.until);
  return Number.isFinite(next) ? next : null;
}

/** Highlights grouped by who made them, in the order the actors first appear. */
export function byActor(highlights: Iterable<Highlight>): Map<string, Highlight[]> {
  const out = new Map<string, Highlight[]>();
  for (const h of highlights) {
    const list = out.get(h.actorId);
    if (list) list.push(h);
    else out.set(h.actorId, [h]);
  }
  return out;
}

// ── Wording ──────────────────────────────────────────────────────────────────

/** The display name of an actor the board knows, or null. */
export function actorName(
  actors: Readonly<Record<string, Actor>>,
  id: string | null,
): string | null {
  if (id === null) return null;
  return Object.hasOwn(actors, id) ? (actors[id]?.name ?? null) : null;
}

/** "3 changes by Demo agent". */
export function changeCountLabel(count: number, name: string | null): string {
  const what = count === 1 ? '1 change' : `${count} changes`;
  return name ? `${what} by ${name}` : what;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Demo agent removed “Retry logic”", "Ada removed 3 nodes", "2 connections were removed". */
export function removalMessage(notice: RemovalNotice, actorName: string | null): string {
  let what: string;
  if (notice.nodes === 1 && notice.titles.length === 1) what = `“${notice.titles[0]}”`;
  else if (notice.nodes > 0) what = plural(notice.nodes, 'node');
  else what = plural(notice.edges, 'connection');
  if (actorName) return `${actorName} removed ${what}`;
  const many = notice.nodes > 1 || (notice.nodes === 0 && notice.edges > 1);
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} ${many ? 'were' : 'was'} removed`;
}

// ── The store ────────────────────────────────────────────────────────────────

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Who removed these entries (an actor id, or the actor and the history batch);
 * ids missing from the answer stay unattributed.
 */
export type RemovalResolver = (
  items: ReadonlyArray<{ kind: ItemKind; id: string }>,
) => Promise<ReadonlyMap<string, string | { actorId: string; batchId?: string }>>;

export interface ActivityOptions {
  me: () => string;
  node(id: string): BoardNode | undefined;
  edge(id: string): BoardEdge | undefined;
  /** False while the document has not finished its first sync. */
  live: () => boolean;
  clock?: Clock;
  resolveRemovals?: RemovalResolver;
}

/** How long a burst of changes must be quiet before follow mode moves the view. */
export const BURST_QUIET_MS = 450;
/** Follow mode moves at least this often during a long burst. */
export const BURST_MAX_MS = 1500;
/** How long to collect removals before asking the server who made them. */
const RESOLVE_DELAY_MS = 200;

export class ActivityStore extends Emitter {
  private state: ActivityState = EMPTY_ACTIVITY;
  private readonly clock: Clock;
  private readonly opts: ActivityOptions;
  private expiryTimer: unknown = null;
  private expiryAt = Number.POSITIVE_INFINITY;

  private burst = new Set<string>();
  private burstStart = 0;
  private burstTimer: unknown = null;
  private readonly burstListeners = new Set<(keys: readonly string[]) => void>();

  private pendingRemovals: RemoteChange[] = [];
  private resolveTimer: unknown = null;
  private destroyed = false;

  constructor(opts: ActivityOptions) {
    super();
    this.opts = opts;
    this.clock = opts.clock ?? systemClock;
  }

  readonly get = (): ActivityState => this.state;

  highlightFor(kind: ItemKind, id: string): Highlight | undefined {
    return this.state.highlights.get(itemKey(kind, id));
  }

  /** Feed one document event. */
  onDocEvent(event: DocEvent): void {
    if (this.destroyed) return;
    const now = this.clock.now();
    const changes = classify(event, {
      me: this.opts.me(),
      node: this.opts.node,
      edge: this.opts.edge,
      live: this.opts.live(),
      now,
    });
    if (changes.length === 0) return;
    const ready: RemoteChange[] = [];
    for (const change of changes) {
      if (change.verb === 'removed' && change.actorId === null && this.opts.resolveRemovals) {
        this.pendingRemovals.push(change);
      } else ready.push(change);
    }
    if (this.pendingRemovals.length > 0) {
      // Highlights of removed entries go now; the notice waits for attribution.
      this.dispatch(forget(this.state, this.pendingRemovals));
      this.scheduleResolve();
    }
    this.dispatch(receive(this.state, ready, this.opts.me(), now));
    this.noteBurst(ready);
  }

  dismissRemoval(id: number): void {
    this.dispatch(dismissRemoval(this.state, id));
  }

  /** Called with the keys of each finished burst of changes by others. */
  onBurst(listener: (keys: readonly string[]) => void): () => void {
    this.burstListeners.add(listener);
    return () => this.burstListeners.delete(listener);
  }

  destroy(): void {
    this.destroyed = true;
    for (const timer of [this.expiryTimer, this.burstTimer, this.resolveTimer])
      if (timer !== null) this.clock.clearTimeout(timer);
    this.burstListeners.clear();
  }

  private dispatch(next: ActivityState): void {
    if (next === this.state) return;
    this.state = next;
    this.scheduleExpiry();
    this.emit();
  }

  private scheduleExpiry(): void {
    const at = nextExpiry(this.state);
    if (at === null || at >= this.expiryAt) {
      if (at === null && this.expiryTimer !== null) {
        this.clock.clearTimeout(this.expiryTimer);
        this.expiryTimer = null;
        this.expiryAt = Number.POSITIVE_INFINITY;
      }
      return;
    }
    if (this.expiryTimer !== null) this.clock.clearTimeout(this.expiryTimer);
    this.expiryAt = at;
    this.expiryTimer = this.clock.setTimeout(
      () => {
        this.expiryTimer = null;
        this.expiryAt = Number.POSITIVE_INFINITY;
        this.dispatch(expire(this.state, this.clock.now()));
        this.scheduleExpiry();
      },
      Math.max(0, at - this.clock.now()),
    );
  }

  private noteBurst(changes: readonly RemoteChange[]): void {
    const keys = changes.filter((c) => c.verb !== 'removed').map((c) => itemKey(c.kind, c.id));
    if (keys.length === 0 || this.burstListeners.size === 0) return;
    const now = this.clock.now();
    if (this.burst.size === 0) this.burstStart = now;
    for (const key of keys) this.burst.add(key);
    if (this.burstTimer !== null) this.clock.clearTimeout(this.burstTimer);
    const wait = Math.min(BURST_QUIET_MS, Math.max(0, this.burstStart + BURST_MAX_MS - now));
    this.burstTimer = this.clock.setTimeout(() => this.flushBurst(), wait);
  }

  private flushBurst(): void {
    this.burstTimer = null;
    // Only what is still highlighted: an entry removed meanwhile is not worth moving to.
    const keys = [...this.burst].filter((key) => this.state.highlights.has(key));
    this.burst = new Set();
    if (keys.length === 0) return;
    for (const listener of [...this.burstListeners]) listener(keys);
  }

  private scheduleResolve(): void {
    if (this.resolveTimer !== null) return;
    this.resolveTimer = this.clock.setTimeout(() => {
      this.resolveTimer = null;
      void this.resolve();
    }, RESOLVE_DELAY_MS);
  }

  private async resolve(): Promise<void> {
    const batch = this.pendingRemovals;
    this.pendingRemovals = [];
    const resolver = this.opts.resolveRemovals;
    if (batch.length === 0 || !resolver) return;
    let actors: Awaited<ReturnType<RemovalResolver>> = new Map();
    try {
      actors = await resolver(batch.map(({ kind, id }) => ({ kind, id })));
    } catch {
      // Without the feed the notice still appears, just without a name.
    }
    if (this.destroyed) return;
    const attributed = batch.map((change): RemoteChange => {
      const found = actors.get(itemKey(change.kind, change.id));
      if (found === undefined) return { ...change, actorId: null };
      if (typeof found === 'string') return { ...change, actorId: found };
      return {
        ...change,
        actorId: found.actorId,
        ...(found.batchId ? { batchId: found.batchId } : {}),
      };
    });
    this.dispatch(receive(this.state, attributed, this.opts.me(), this.clock.now()));
  }
}
