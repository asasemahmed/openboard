/**
 * One live board: its document, the store that persists it, its change feed,
 * and the presence of everyone connected to it.
 */
import { type Actor, ActorSchema, BoardDoc, type Presence, type TxOrigin } from '@openboard/core';
import { Awareness } from 'y-protocols/awareness';
import { ChangeFeed } from './feed.js';
import { Mutex } from './mutex.js';
import { BoardStore, type FileStatus, loadBoard, type StoreFiles } from './store.js';

export interface RoomFiles extends StoreFiles {
  changes: string;
}

export interface RoomOptions {
  log?: (line: string) => void;
  debounceMs?: number;
}

/** A human's current selection, as published over awareness. */
export interface HumanSelection {
  by: Actor;
  nodeIds: string[];
  edgeIds: string[];
  at: string;
}

export class Room {
  readonly awareness: Awareness;
  /** Serializes agent writes (apply and layout) on this board. */
  readonly lock = new Mutex();
  /** Actors seen on this board's connections and sessions, for labelling the change feed. */
  readonly knownActors = new Map<string, Actor>();
  private readonly detachFeed: () => void;

  private constructor(
    readonly id: string,
    readonly doc: BoardDoc,
    readonly store: BoardStore,
    readonly feed: ChangeFeed,
  ) {
    this.awareness = new Awareness(doc.ydoc);
    // The server itself has no presence; only connected clients do.
    this.awareness.setLocalState(null);
    this.detachFeed = feed.attach(doc);
  }

  /** Open a board that exists on disk, or return null when it does not. */
  static async open(id: string, files: RoomFiles, opts: RoomOptions = {}): Promise<Room | null> {
    const loaded = await loadBoard(files);
    if (!loaded) return null;
    const feed = await ChangeFeed.open(files.changes, { log: opts.log });
    const store = new BoardStore(loaded.doc, files, loaded, opts);
    const room = new Room(id, loaded.doc, store, feed);
    // The file changed while the server was not running: catch up, and let the
    // feed record what changed.
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
    const feed = await ChangeFeed.open(files.changes, { log: opts.log });
    const store = new BoardStore(doc, files, { fileText: null }, opts);
    const room = new Room(id, doc, store, feed);
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

  /** Actor labels for rendering: the board's registry plus everyone seen live. */
  actors(): Record<string, Actor> {
    return { ...Object.fromEntries(this.knownActors), ...this.doc.toJSON().actors };
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

  async flush(): Promise<void> {
    await this.store.flush();
    await this.feed.flush();
  }

  async close(): Promise<void> {
    await this.store.close();
    await this.feed.flush();
    this.detachFeed();
    this.awareness.destroy();
  }
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
