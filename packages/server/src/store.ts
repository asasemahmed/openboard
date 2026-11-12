/**
 * Persistence for one live board.
 *
 * The board file (`.openboard/<id>.board.json`) is the source of truth; the
 * `.local/<id>.ydoc` snapshot only makes restarts keep document history. The
 * store writes the file a moment after the board changes, and reconciles the
 * live document when someone else changes the file (a checkout, a merge, an
 * editor).
 *
 * Every file operation runs on one serial queue, so a save and a reload never
 * race each other. Our own writes are recognized by content hash, which is
 * what keeps a save from being read back as an external edit.
 */
import { stat, unlink } from 'node:fs/promises';
import { BoardDoc, OpenBoardError, parseBoard, serializeBoard } from '@openboard/core';
import { errorMessage, isErrno, readIfExists, sha256, writeFileAtomic } from './fsutil.js';

export type FileStatus = 'ok' | 'conflict';

/** How long the store waits after a change before writing, so a burst of edits is one write. */
export const SAVE_DEBOUNCE_MS = 250;
/** The `.ydoc` snapshot is rewritten at most this often (and always on flush). */
const YDOC_INTERVAL_MS = 2000;

export interface StoreFiles {
  board: string;
  ydoc: string;
}

export interface LoadedBoard {
  doc: BoardDoc;
  /** The board file as read, or null when it does not exist. */
  fileText: string | null;
  /** Set when the board file exists but does not parse. */
  fileError?: string;
  /** The parsed file, when it exists, parses, and differs from the document restored from `.ydoc`. */
  reconcileTo?: ReturnType<typeof parseBoard>;
  /** True when the document came from the `.ydoc` snapshot, false when it was rebuilt from the file. */
  restored: boolean;
}

/**
 * Read a board from disk without changing anything. Returns null when there is
 * no board file. A `.ydoc` without its board file does not count as a board:
 * the file is the source of truth, and its absence means the board was
 * deleted.
 */
export async function loadBoard(files: StoreFiles): Promise<LoadedBoard | null> {
  const fileBytes = await readIfExists(files.board);
  if (fileBytes === null) return null;
  const fileText = fileBytes.toString('utf8');
  let parsed: ReturnType<typeof parseBoard> | undefined;
  let fileError: string | undefined;
  try {
    parsed = parseBoard(fileText);
  } catch (error) {
    fileError = errorMessage(error);
  }

  let doc: BoardDoc | null = null;
  const snapshot = await readIfExists(files.ydoc);
  if (snapshot) {
    try {
      doc = BoardDoc.fromUpdate(new Uint8Array(snapshot));
      if (!doc.ready) doc = null;
    } catch {
      doc = null;
    }
  }

  if (!doc) {
    if (!parsed) {
      throw new OpenBoardError(
        'conflict',
        `the board file ${files.board} does not parse, so the board cannot be opened: ${fileError}`,
      );
    }
    return { doc: BoardDoc.fromJSON(parsed), fileText, restored: false };
  }
  const loaded: LoadedBoard = { doc, fileText, restored: true };
  if (fileError !== undefined) loaded.fileError = fileError;
  else if (parsed && serializeBoard(parsed) !== serializeBoard(doc.toJSON()))
    loaded.reconcileTo = parsed;
  return loaded;
}

export interface StoreOptions {
  log?: (line: string) => void;
  debounceMs?: number;
}

export class BoardStore {
  private status: FileStatus = 'ok';
  private error: string | undefined;
  /** Hash of the board file as we last wrote or read it; null when it is gone. */
  private knownHash: string | null;
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private lastYdocWrite = 0;
  private ydocDirty = false;
  /** The document changed since the board file was last written. */
  private fileDirty = false;
  private closed = false;
  /** `ino:size:mtime` of the board file when it was last read; a different value means it changed. */
  private seenStat: string | null = null;
  private readonly offUpdate: () => void;
  private readonly log: (line: string) => void;
  private readonly debounceMs: number;

  constructor(
    private readonly doc: BoardDoc,
    private readonly files: StoreFiles,
    initial: { fileText: string | null; fileError?: string },
    opts: StoreOptions = {},
  ) {
    this.log = opts.log ?? (() => {});
    this.debounceMs = opts.debounceMs ?? SAVE_DEBOUNCE_MS;
    this.knownHash = initial.fileText === null ? null : sha256(initial.fileText);
    if (initial.fileError !== undefined) this.markConflict(initial.fileError);
    const onUpdate = () => this.changed();
    doc.ydoc.on('update', onUpdate);
    this.offUpdate = () => doc.ydoc.off('update', onUpdate);
  }

  get fileStatus(): FileStatus {
    return this.status;
  }

  /** Why the board file is in conflict, when it is. */
  get fileError(): string | undefined {
    return this.error;
  }

  /** Schedule a save. Called on every document update. */
  private changed(): void {
    if (this.closed) return;
    this.ydocDirty = true;
    this.fileDirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueue(() => this.save(false));
    }, this.debounceMs);
  }

  /** Write everything pending now. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.enqueue(() => this.save(true));
  }

  /** Write the board file and snapshot now, even without a pending change (a new board). */
  writeNow(): Promise<void> {
    this.fileDirty = true;
    this.ydocDirty = true;
    return this.flush();
  }

  /** Flush, then stop reacting to document updates. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    this.offUpdate();
  }

  /**
   * The board file changed, appeared, or disappeared on disk. Reload it unless
   * the change is our own write.
   */
  fileChanged(): Promise<void> {
    return this.enqueue(() => this.reload());
  }

  /**
   * Reload if the file's identity, size or mtime changed since it was last
   * read. Watchers can miss an event (a rename over the file can leave a
   * per-file watch attached to the old inode), so this runs on a timer as a
   * backstop; it costs one `stat`.
   */
  async poll(): Promise<void> {
    if (this.closed) return;
    const current = await statKey(this.files.board);
    if (current !== this.seenStat) await this.fileChanged();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task).catch((error: unknown) => {
      this.log(`board store: ${errorMessage(error)}`);
    });
    this.queue = next;
    return next;
  }

  private async save(final: boolean): Promise<void> {
    if (!this.doc.ready) {
      this.log(`not saving ${this.files.board}: the document has no valid board metadata`);
      return;
    }
    // A file in conflict belongs to whoever is resolving it; never overwrite it.
    if (this.status === 'ok' && this.fileDirty) {
      this.fileDirty = false;
      const text = serializeBoard(this.doc.toJSON());
      const hash = sha256(text);
      if (hash !== this.knownHash) {
        // Record the hash before writing so the watcher event of this write is recognized.
        this.knownHash = hash;
        await writeFileAtomic(this.files.board, text);
      }
    }
    const now = Date.now();
    if (this.ydocDirty && (final || now - this.lastYdocWrite >= YDOC_INTERVAL_MS)) {
      this.ydocDirty = false;
      this.lastYdocWrite = now;
      await writeFileAtomic(this.files.ydoc, this.doc.encodeState());
    }
  }

  private async reload(): Promise<void> {
    // Stat before reading: a write that lands in between is seen by the next poll.
    this.seenStat = await statKey(this.files.board);
    const bytes = await readIfExists(this.files.board);
    if (bytes === null) {
      if (this.knownHash !== null) {
        this.log(`${this.files.board} was deleted; it will be written again on the next change`);
      }
      // Keep the board in memory; the next change writes the file again.
      this.knownHash = null;
      this.clearConflict();
      return;
    }
    const text = bytes.toString('utf8');
    const hash = sha256(text);
    if (hash === this.knownHash) return;
    let board: ReturnType<typeof parseBoard>;
    try {
      board = parseBoard(text);
    } catch (error) {
      this.knownHash = hash;
      this.markConflict(errorMessage(error));
      return;
    }
    this.knownHash = hash;
    this.clearConflict();
    this.doc.reconcile(board, this.doc.origin('system', 'file'));
  }

  private markConflict(message: string): void {
    if (this.status !== 'conflict' || this.error !== message) {
      this.log(`${this.files.board} does not parse; not saving until it does: ${message}`);
    }
    this.status = 'conflict';
    this.error = message;
  }

  private clearConflict(): void {
    if (this.status === 'conflict') this.log(`${this.files.board} parses again`);
    this.status = 'ok';
    this.error = undefined;
  }

  /** Remove the runtime snapshot; used when a board is created over a stale one. */
  static async discardSnapshot(files: StoreFiles): Promise<void> {
    try {
      await unlink(files.ydoc);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }
}

async function statKey(file: string): Promise<string | null> {
  try {
    const st = await stat(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}
