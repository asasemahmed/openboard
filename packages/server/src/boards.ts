/**
 * The boards of one project root. Boards are discovered from the
 * `*.board.json` files in `.openboard/` and opened lazily on first use; once
 * open, a board stays live until the server closes.
 *
 * One directory watcher covers every board file, so a checkout that adds,
 * changes or deletes boards is seen without a watcher per board.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  type Actor,
  type Batch,
  BoardDoc,
  type BoardSummary,
  type CreateBoardInput,
  OpenBoardError,
  slugify,
} from '@openboard/core';
import { type FSWatcher, watch } from 'chokidar';
import { AccessStore } from './access.js';
import { guardAuthorship } from './authorship.js';
import { CodeLinks } from './code.js';
import { ConfigStore } from './config.js';
import { ensureLocalDir, errorMessage, isErrno } from './fsutil.js';
import { Git } from './git.js';
import { LiveHub } from './live.js';
import { assertBoardId, boardIdFromFile, CONFIG_FILE, localBoardFiles } from './paths.js';
import { PluginHost } from './plugins.js';
import { refreshProposals } from './review.js';
import { Room, type RoomFiles } from './room.js';
import type { FileStatus } from './store.js';
import { TemplateCatalog } from './templates.js';
import type { ProjectPaths } from './types.js';

/** A board as listed over HTTP: its summary plus the state of its file. */
export interface BoardListing extends BoardSummary {
  fileStatus: FileStatus;
  /** The live document's lineage; a browser passes it as `?lineage=` when it syncs. */
  lineage: string;
  /** Why the file does not parse, when `fileStatus` is `conflict`. */
  fileError?: string;
}

/** How often live board files are checked for changes a watcher missed. */
const POLL_INTERVAL_MS = 1000;

export interface BoardsOptions {
  log?: (line: string) => void;
  debounceMs?: number;
  /** Called (debounced, under the board's lock) when pending proposals may be stale. */
  onProposalsStale?: (room: Room) => Promise<void>;
  /** Milliseconds since the epoch for presence, sessions and claims. Injectable for tests. */
  clock?: () => number;
  /** Shared mode: an access file that does not parse stops the start instead of being ignored. */
  shared?: boolean;
  /** This server's plugins; none when omitted. */
  plugins?: PluginHost;
}

export class Boards {
  private readonly rooms = new Map<string, Promise<Room | null>>();
  private readonly open = new Map<string, Room>();
  private watcher: FSWatcher | null = null;
  private poller: NodeJS.Timeout | null = null;
  private closing = false;
  private readonly log: (line: string) => void;
  /** `.openboard/config.json`, shared by every board of the project. */
  readonly config: ConfigStore;
  /** Presence, sessions and claim upkeep for every open board. */
  readonly live: LiveHub;
  /** The clock used for presence, sessions and claims. */
  readonly clock: () => number;
  /** Code-link upkeep for every open board. */
  readonly code: CodeLinks;
  /** The project's git repository, if any. */
  readonly git: Git;
  /** Access grants, sessions and tickets (`.openboard/.local/access.json`). */
  readonly access: AccessStore;
  /** Whether the server runs in shared mode. */
  readonly shared: boolean;
  /** The URL people use to reach the server; set once it listens. Invite links start with it. */
  publicUrl = '';
  /** This server's plugins, and with them its extra types, formats and templates. */
  readonly plugins: PluginHost;
  /** Built-in, plugin and project templates. */
  readonly templates: TemplateCatalog;
  private readonly opts: BoardsOptions & {
    config: ConfigStore;
    onBatch: (room: Room, batch: Batch) => void;
  };

  constructor(
    readonly paths: ProjectPaths,
    opts: BoardsOptions = {},
  ) {
    this.log = opts.log ?? (() => {});
    this.config = new ConfigStore(paths.config, this.log);
    this.clock = opts.clock ?? (() => Date.now());
    this.live = new LiveHub({
      clock: this.clock,
      rooms: () => [...this.open.values()],
      log: this.log,
    });
    this.code = new CodeLinks(paths.root, this.log);
    this.git = new Git(paths.root);
    this.shared = opts.shared === true;
    this.access = new AccessStore(paths.local, {
      clock: this.clock,
      log: this.log,
      strict: this.shared,
    });
    this.plugins = opts.plugins ?? new PluginHost([], this.log);
    this.templates = new TemplateCatalog(paths.templates, this.plugins, this.log);
    const plugins = this.plugins;
    this.opts = {
      onProposalsStale: (room) => refreshProposals(room, this.log),
      ...opts,
      config: this.config,
      onBatch: (room, batch) => plugins.batch(room.id, batch, () => room.doc.toJSON()),
    };
  }

  /** Create the project directories and start watching board files. */
  async start(): Promise<void> {
    await ensureLocalDir(this.paths.local);
    await this.config.load();
    await this.access.load();
    const watcher = watch(this.paths.dir, {
      depth: 0,
      ignoreInitial: true,
      ignored: (file: string) =>
        file !== this.paths.dir &&
        file !== this.paths.config &&
        boardIdFromFile(path.basename(file)) === null,
    });
    watcher.on('all', (_event, file) => this.onFileEvent(file));
    watcher.on('error', (error) => this.log(`watcher: ${errorMessage(error)}`));
    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
    this.watcher = watcher;
    this.poller = setInterval(() => {
      this.config.poll().catch((error: unknown) => this.log(`poll: ${errorMessage(error)}`));
      for (const room of this.open.values()) {
        room.store.poll().catch((error: unknown) => this.log(`poll: ${errorMessage(error)}`));
      }
    }, POLL_INTERVAL_MS);
    this.poller.unref();
  }

  private files(id: string): RoomFiles {
    return { board: this.paths.boardFile(id), ...localBoardFiles(this.paths, id) };
  }

  private onFileEvent(file: string): void {
    if (path.basename(file) === CONFIG_FILE && path.dirname(file) === this.paths.dir) {
      void this.config.fileChanged();
      return;
    }
    const id = boardIdFromFile(path.basename(file));
    if (id === null || path.dirname(file) !== this.paths.dir) return;
    const room = this.open.get(id);
    if (room) void room.store.fileChanged();
  }

  /** Ids of every board: files on disk plus boards that are live in memory. */
  async ids(): Promise<string[]> {
    const ids = new Set(this.open.keys());
    try {
      for (const name of await readdir(this.paths.dir)) {
        const id = boardIdFromFile(name);
        if (id !== null) ids.add(id);
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    return [...ids].sort();
  }

  /** The live board, opening it from disk if needed. Throws `board_not_found`. */
  async get(id: string): Promise<Room> {
    const room = await this.find(id);
    if (!room) throw new OpenBoardError('board_not_found', `no board with id "${id}"`);
    return room;
  }

  /** The live board, or null when it does not exist. */
  async find(id: string): Promise<Room | null> {
    assertBoardId(id);
    if (this.closing) throw new OpenBoardError('unavailable', 'the server is shutting down');
    let pending = this.rooms.get(id);
    if (!pending) {
      pending = Room.open(id, this.files(id), this.opts);
      this.rooms.set(id, pending);
      pending.then(
        (room) => {
          if (room) {
            this.open.set(id, room);
            this.live.roomOpened(room);
            this.code.attach(room);
            if (this.shared) guardAuthorship(room, this.log);
          }
          // Not there (yet): forget the miss so a later call looks again.
          else this.rooms.delete(id);
        },
        () => this.rooms.delete(id),
      );
    }
    return pending;
  }

  async create(input: CreateBoardInput, actor: Actor): Promise<Room> {
    const id = assertBoardId(input.id ?? slugify(input.name));
    if (this.closing) throw new OpenBoardError('unavailable', 'the server is shutting down');
    const existing = await this.find(id).catch((error: unknown) => {
      // A board whose file does not parse still exists.
      if (error instanceof OpenBoardError && error.code === 'conflict') return true;
      throw error;
    });
    if (existing)
      throw new OpenBoardError('board_exists', `a board with id "${id}" already exists`);
    if (this.rooms.has(id)) {
      throw new OpenBoardError('board_exists', `a board with id "${id}" is being created`);
    }
    const doc = BoardDoc.create({
      id,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
    });
    const pending = Room.create(id, doc, this.files(id), this.opts);
    this.rooms.set(id, pending);
    try {
      const room = await pending;
      this.open.set(id, room);
      this.live.roomOpened(room);
      this.code.attach(room);
      if (this.shared) guardAuthorship(room, this.log);
      room.knownActors.set(actor.id, actor);
      return room;
    } catch (error) {
      this.rooms.delete(id);
      throw error;
    }
  }

  /** Summaries of every board that can be opened, with the state of its file. */
  async list(): Promise<BoardListing[]> {
    const out: BoardListing[] = [];
    for (const id of await this.ids()) {
      try {
        const room = await this.find(id);
        if (room) out.push(listing(room));
      } catch (error) {
        this.log(`board "${id}" is not listed: ${errorMessage(error)}`);
      }
    }
    return out;
  }

  /** The boards that are open right now. */
  openRooms(): Room[] {
    return [...this.open.values()];
  }

  /** Flush every live board to disk. */
  async flush(): Promise<void> {
    await Promise.all([...this.open.values()].map((room) => room.flush()));
  }

  async close(): Promise<void> {
    // Plugins go first: running hooks and teardowns may still use the boards.
    await this.plugins.close();
    this.closing = true;
    this.live.close();
    await this.code.close();
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    await this.watcher?.close();
    this.watcher = null;
    await Promise.allSettled([...this.rooms.values()]);
    await Promise.all([...this.open.values()].map((room) => room.close()));
    await this.access.close();
  }
}

export function listing(room: Room): BoardListing {
  const out: BoardListing = {
    ...room.doc.summary(),
    fileStatus: room.fileStatus,
    lineage: room.lineage,
  };
  const error = room.store.fileError;
  if (error !== undefined) out.fileError = error;
  return out;
}
