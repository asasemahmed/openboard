/**
 * Code links that notice when code changes.
 *
 * `file` and `symbol` links point into the project (a path relative to the
 * root; `symbol` is `path#name`). The server fills `hash` from the linked
 * content (see `LINK_HASH_PREFIX` in core), watches every linked file, and
 * when the content no longer matches either moves `line`/`endLine` (the same
 * text sits elsewhere in the file, exactly once) or sets `stale: true`. It
 * clears `stale` again when the content matches.
 *
 * Those writes are made as the system actor with source `code`: they keep
 * the node's bookkeeping fields, show in the change feed, and are not history
 * batches. Nothing is written when nothing changed.
 *
 * Paths that leave the project root (after normalisation, or through a
 * symlink) are never read; their links are reported as `outside`. The text of
 * linked ranges is kept in memory only, to recognise moved code; it is never
 * stored in the board.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type BoardNode,
  LINK_HASH_PREFIX,
  type Link,
  type LinkEntry,
  type LinkState,
  RELOCATE_MAX_LINES,
} from '@openboard/core';
import { type FSWatcher, watch } from 'chokidar';
import { errorMessage, isErrno } from './fsutil.js';
import { jsonEqual } from './json.js';
import type { Room } from './room.js';

/** Files larger than this are not read; their links stay `unchecked`. */
export const MAX_LINKED_FILE_BYTES = 5 * 1024 * 1024;
/** At most this many files are watched; more are still checked on load and by the poll. */
export const MAX_WATCHED_FILES = 2000;
/** Changes to one file within this time are handled once. */
const DEBOUNCE_MS = 150;
/** Linked files are also polled this often, for changes a watcher missed. */
const POLL_MS = 2000;
/** Memory for the text of hashed ranges, used to find moved code. */
const TEXT_MEMORY_BYTES = 4 * 1024 * 1024;

/** The content hash stored in `Link.hash`. */
export function hashContent(text: string): string {
  return `${LINK_HASH_PREFIX}${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)}`;
}

function normalise(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** The text of a link's range, or null when the range is not in the file. */
function rangeText(lines: string[], link: Link): string | null {
  if (link.line === undefined) return lines.join('\n');
  const end = link.endLine ?? link.line;
  if (link.line < 1 || end < link.line || end > lines.length) return null;
  return lines.slice(link.line - 1, end).join('\n');
}

function rangeLabel(link: Link): string {
  if (link.line === undefined) return '';
  const end = link.endLine ?? link.line;
  return end === link.line ? `line ${link.line}` : `lines ${link.line}-${end}`;
}

type Resolved = { abs: string } | { outside: string };

interface FileState {
  key: string | null;
  /** Normalised text, or null when the file is missing; undefined when too large. */
  text: string | null | undefined;
}

interface Evaluation {
  state: LinkState;
  detail?: string;
  /** The link as it should be stored, when that differs. */
  next?: Link;
}

export class CodeLinks {
  private rootReal: string | null = null;
  private readonly rooms = new Map<Room, () => void>();
  private readonly files = new Map<string, FileState>();
  /** Linked files per room. */
  private readonly linked = new Map<Room, Set<string>>();
  private readonly texts = new Map<string, string>();
  private textBytes = 0;
  private watcher: FSWatcher | null = null;
  private watched = new Set<string>();
  private readonly fileTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingNodes = new Map<Room, Set<string> | 'all'>();
  private readonly roomTimers = new Map<Room, NodeJS.Timeout>();
  private running = new Set<Promise<void>>();
  private readonly poller: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly root: string,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.poller = setInterval(() => void this.poll(), POLL_MS);
    this.poller.unref();
  }

  // ── Rooms ──────────────────────────────────────────────────────────────────

  /** Start keeping a board's links current, and check all of them once. */
  attach(room: Room): void {
    if (this.closed || this.rooms.has(room)) return;
    const off = room.doc.observe((event) => {
      if (event.origin?.source === 'code' || !event.states) return;
      const ids: string[] = [];
      for (const [id, state] of Object.entries(event.states.nodes)) {
        if (state.after && !jsonEqual(state.before?.links, state.after.links)) ids.push(id);
      }
      if (ids.length > 0) this.schedule(room, ids);
    });
    this.rooms.set(room, off);
    this.schedule(room, 'all');
  }

  detach(room: Room): void {
    this.rooms.get(room)?.();
    this.rooms.delete(room);
    this.linked.delete(room);
    const timer = this.roomTimers.get(room);
    if (timer) clearTimeout(timer);
    this.roomTimers.delete(room);
    this.pendingNodes.delete(room);
    void this.updateWatcher();
  }

  /** Resolves once every scheduled check has run; for tests and shutdown. */
  async idle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      if (this.roomTimers.size === 0 && this.fileTimers.size === 0 && this.running.size === 0)
        return;
      for (const [room, timer] of [...this.roomTimers]) {
        clearTimeout(timer);
        this.roomTimers.delete(room);
        this.track(this.run(room));
      }
      for (const [file, timer] of [...this.fileTimers]) {
        clearTimeout(timer);
        this.fileTimers.delete(file);
        this.fileChanged(file);
      }
      await Promise.all([...this.running]);
    }
  }

  private track(task: Promise<void>): void {
    this.running.add(task);
    void task.finally(() => this.running.delete(task));
  }

  private schedule(room: Room, ids: string[] | 'all'): void {
    if (this.closed) return;
    const current = this.pendingNodes.get(room);
    if (ids === 'all' || current === 'all') this.pendingNodes.set(room, 'all');
    else this.pendingNodes.set(room, new Set([...(current ?? []), ...ids]));
    if (this.roomTimers.has(room)) return;
    this.roomTimers.set(
      room,
      setTimeout(() => {
        this.roomTimers.delete(room);
        this.track(this.run(room));
      }, DEBOUNCE_MS),
    );
  }

  private async run(room: Room): Promise<void> {
    const ids = this.pendingNodes.get(room);
    this.pendingNodes.delete(room);
    if (!ids || !this.rooms.has(room)) return;
    try {
      await room.lock.run(() => this.check(room, ids === 'all' ? undefined : ids));
    } catch (error) {
      this.log(`code links on "${room.id}": ${errorMessage(error)}`);
    }
  }

  // ── Checking ───────────────────────────────────────────────────────────────

  /** Bring the links of these nodes (all when omitted) up to date, writing what changed. */
  private async check(room: Room, ids?: Set<string>): Promise<void> {
    if (this.closed) return;
    const nodes = ids
      ? [...ids].map((id) => room.doc.storedNode(id)).filter((n): n is BoardNode => !!n)
      : Object.values(room.doc.raw().nodes);
    const updates: Record<string, BoardNode> = {};
    for (const node of nodes) {
      if (!node.links?.length) continue;
      let changed = false;
      const links: Link[] = [];
      for (const link of node.links) {
        const evaluation = await this.evaluate(link, true);
        if (evaluation.next && !jsonEqual(evaluation.next, link)) {
          links.push(evaluation.next);
          changed = true;
        } else links.push(link);
      }
      // The node may have changed while files were read; only write over what was read.
      if (changed && jsonEqual(room.doc.storedNode(node.id)?.links, node.links)) {
        updates[node.id] = { ...node, links };
      }
    }
    if (Object.keys(updates).length > 0) {
      room.doc.restore({ nodes: updates }, room.doc.origin('system', 'code'));
    }
    this.reindex(room);
  }

  /** Every link of the board with its state, read fresh from disk. Writes nothing. */
  /**
   * Every link of the board with its state. Pending upkeep is written first,
   * so the answer is the document's state: what reads and the outline show.
   */
  async entries(room: Room): Promise<LinkEntry[]> {
    this.pendingNodes.delete(room);
    const timer = this.roomTimers.get(room);
    if (timer) clearTimeout(timer);
    this.roomTimers.delete(room);
    await room.lock.run(() => this.check(room));
    const out: LinkEntry[] = [];
    const board = room.doc.toJSON();
    const ordered = Object.values(board.nodes).sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const node of ordered) {
      for (const [index, link] of (node.links ?? []).entries()) {
        const entry: LinkEntry = { nodeId: node.id, title: node.title, index, link, state: 'ok' };
        const evaluation = await this.evaluate(link, false);
        if (evaluation.state === 'outside' || evaluation.state === 'unchecked') {
          entry.state = evaluation.state;
        } else if (link.stale) {
          entry.state = evaluation.state === 'missing' ? 'missing' : 'stale';
        } else if (link.hash === undefined) entry.state = 'unchecked';
        // `detail` explains a state that is not ok; for an ok link it says where it moved.
        const detail = entry.state === evaluation.state ? evaluation.detail : undefined;
        if (detail) entry.detail = detail;
        else if (entry.state === 'stale') entry.detail = 'content changed';
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Fill `hash` on the `file` and `symbol` links a batch stores, from the code
   * as it is now, so a link is never stored unhashed through the API (a
   * missing file or a range not in the file marks it `stale` instead). Other
   * operations, and anything malformed, pass through untouched for validation.
   */
  async prepareOps<T>(ops: T[]): Promise<T[]> {
    const out: T[] = [];
    for (const op of ops) {
      const raw = op as { op?: unknown; node?: { links?: unknown }; patch?: { links?: unknown } };
      const holder =
        raw?.op === 'add_node' ? raw.node : raw?.op === 'update_node' ? raw.patch : undefined;
      if (!holder || !Array.isArray(holder.links)) {
        out.push(op);
        continue;
      }
      const links = await Promise.all(holder.links.map((link: unknown) => this.hashOne(link)));
      const next = { ...holder, links };
      out.push({ ...raw, ...(raw.op === 'add_node' ? { node: next } : { patch: next }) } as T);
    }
    return out;
  }

  private async hashOne(link: unknown): Promise<unknown> {
    const candidate = link as Partial<Link> | null;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      (candidate.kind !== 'file' && candidate.kind !== 'symbol') ||
      typeof candidate.target !== 'string' ||
      candidate.hash !== undefined
    ) {
      return link;
    }
    try {
      const evaluation = await this.evaluate(candidate as Link, true);
      return evaluation.next ?? link;
    } catch {
      return link;
    }
  }

  /**
   * A node's links re-hashed against the code as it is now, `stale` cleared,
   * for `refreshLinks`. Links whose file is missing or outside stay as they are.
   */
  async rehash(node: BoardNode): Promise<Link[] | undefined> {
    if (!node.links?.length) return undefined;
    const out: Link[] = [];
    for (const link of node.links) {
      if (link.kind !== 'file' && link.kind !== 'symbol') {
        out.push(link);
        continue;
      }
      const resolved = await this.resolve(link);
      const file = 'abs' in resolved ? await this.read(resolved.abs) : undefined;
      const text = typeof file?.text === 'string' ? rangeText(file.text.split('\n'), link) : null;
      if (text === null) {
        out.push(link);
        continue;
      }
      const { stale: _stale, ...rest } = link;
      const hash = hashContent(text);
      this.remember(hash, text, link);
      out.push({ ...rest, hash });
    }
    return out;
  }

  private async evaluate(link: Link, remember: boolean): Promise<Evaluation> {
    if (link.kind !== 'file' && link.kind !== 'symbol') return { state: 'unchecked' };
    const resolved = await this.resolve(link);
    if ('outside' in resolved) {
      return { state: 'outside', detail: resolved.outside };
    }
    const file = await this.read(resolved.abs);
    if (file.text === undefined) return { state: 'unchecked', detail: 'file too large to check' };
    const withStale = (stale: boolean): Link => {
      const { stale: _s, ...rest } = link;
      return stale ? { ...rest, stale: true } : rest;
    };
    if (file.text === null) {
      return { state: 'missing', detail: 'file missing', next: withStale(true) };
    }
    const lines = file.text.split('\n');
    const current = rangeText(lines, link);
    if (link.hash === undefined) {
      if (!remember) return { state: 'unchecked', detail: 'not hashed yet' };
      if (current === null) {
        return {
          state: 'stale',
          detail: `${rangeLabel(link)} not in the file`,
          next: withStale(true),
        };
      }
      const hash = hashContent(current);
      if (remember) this.remember(hash, current, link);
      return { state: 'ok', next: { ...withStale(false), hash } };
    }
    if (current !== null && hashContent(current) === link.hash) {
      if (remember) this.remember(link.hash, current, link);
      return { state: 'ok', next: withStale(false) };
    }
    // Changed. If the original text of a range sits exactly once elsewhere, the code moved.
    const original = link.line !== undefined ? this.texts.get(link.hash) : undefined;
    if (original !== undefined) {
      const found = findOnce(lines, original.split('\n'));
      if (found !== null) {
        const length = original.split('\n').length;
        const moved: Link = { ...withStale(false), line: found };
        if (link.endLine !== undefined || length > 1) moved.endLine = found + length - 1;
        else delete moved.endLine;
        return { state: 'ok', detail: `moved to ${rangeLabel(moved)}`, next: moved };
      }
    }
    const where = link.line !== undefined ? ` at ${rangeLabel(link)}` : '';
    return { state: 'stale', detail: `content changed${where}`, next: withStale(true) };
  }

  private remember(hash: string, text: string, link: Link): void {
    if (link.line === undefined) return;
    if (text.split('\n').length > RELOCATE_MAX_LINES || this.texts.has(hash)) {
      if (this.texts.has(hash)) {
        // Most recently used last.
        this.texts.delete(hash);
        this.texts.set(hash, text);
      }
      return;
    }
    this.texts.set(hash, text);
    this.textBytes += text.length;
    for (const [key, value] of this.texts) {
      if (this.textBytes <= TEXT_MEMORY_BYTES) break;
      this.texts.delete(key);
      this.textBytes -= value.length;
    }
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  private async resolve(link: Link): Promise<Resolved> {
    let target = link.kind === 'symbol' ? (link.target.split('#')[0] ?? '') : link.target;
    target = target.trim();
    if (target === '') return { outside: 'no path' };
    const abs = path.resolve(this.root, target);
    const rel = path.relative(this.root, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { outside: 'the path is outside the project' };
    }
    this.rootReal ??= await realpath(this.root).catch(() => this.root);
    try {
      const real = await realpath(abs);
      const relReal = path.relative(this.rootReal, real);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
        return { outside: 'the path leads outside the project through a symlink' };
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) throw error;
    }
    return { abs };
  }

  private async read(abs: string): Promise<FileState> {
    const key = await statKey(abs);
    const cached = this.files.get(abs);
    if (cached && cached.key === key) return cached;
    let text: string | null | undefined = null;
    if (key !== null) {
      const size = Number(key.split(':')[1]);
      if (size > MAX_LINKED_FILE_BYTES) text = undefined;
      else {
        try {
          text = normalise(await readFile(abs, 'utf8'));
        } catch (error) {
          if (!isErrno(error, 'ENOENT') && !isErrno(error, 'EISDIR')) throw error;
          text = null;
        }
      }
    }
    const state: FileState = { key, text };
    this.files.set(abs, state);
    return state;
  }

  /** Recompute which files a room links to, and watch the union. */
  private reindex(room: Room): void {
    if (!this.rooms.has(room)) return;
    const files = new Set<string>();
    for (const node of room.doc.nodes()) {
      for (const link of node.links ?? []) {
        if (link.kind !== 'file' && link.kind !== 'symbol') continue;
        const target = link.kind === 'symbol' ? (link.target.split('#')[0] ?? '') : link.target;
        const abs = path.resolve(this.root, target.trim());
        const rel = path.relative(this.root, abs);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) files.add(abs);
      }
    }
    this.linked.set(room, files);
    void this.updateWatcher();
  }

  private allLinked(): Set<string> {
    const all = new Set<string>();
    for (const files of this.linked.values()) for (const file of files) all.add(file);
    return all;
  }

  private async updateWatcher(): Promise<void> {
    if (this.closed) return;
    const wanted = new Set([...this.allLinked()].slice(0, MAX_WATCHED_FILES));
    const add = [...wanted].filter((file) => !this.watched.has(file));
    const remove = [...this.watched].filter((file) => !wanted.has(file));
    if (add.length === 0 && remove.length === 0) return;
    if (!this.watcher) {
      // `atomic` keeps following a file that editors replace by writing a new one and renaming it.
      this.watcher = watch([], { ignoreInitial: true, atomic: true });
      this.watcher.on('all', (_event, file) => this.debounceFile(path.resolve(file)));
      this.watcher.on('error', (error) => this.log(`code watcher: ${errorMessage(error)}`));
    }
    if (add.length) this.watcher.add(add);
    if (remove.length) this.watcher.unwatch(remove);
    this.watched = wanted;
  }

  private debounceFile(file: string): void {
    if (this.closed) return;
    const existing = this.fileTimers.get(file);
    if (existing) clearTimeout(existing);
    this.fileTimers.set(
      file,
      setTimeout(() => {
        this.fileTimers.delete(file);
        this.fileChanged(file);
      }, DEBOUNCE_MS),
    );
  }

  /** A linked file changed (or may have): check the nodes that link to it. */
  private fileChanged(file: string): void {
    this.files.delete(file);
    for (const [room, files] of this.linked) {
      if (!files.has(file)) continue;
      const ids = room.doc
        .nodes()
        .filter((node) =>
          (node.links ?? []).some((link) => {
            const target = link.kind === 'symbol' ? (link.target.split('#')[0] ?? '') : link.target;
            return (
              (link.kind === 'file' || link.kind === 'symbol') &&
              path.resolve(this.root, target.trim()) === file
            );
          }),
        )
        .map((node) => node.id);
      if (ids.length) this.schedule(room, ids);
    }
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    for (const file of this.allLinked()) {
      const cached = this.files.get(file);
      if (!cached) continue;
      const key = await statKey(file).catch(() => null);
      if (key !== cached.key) this.debounceFile(file);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.poller);
    for (const timer of [...this.roomTimers.values(), ...this.fileTimers.values()])
      clearTimeout(timer);
    this.roomTimers.clear();
    this.fileTimers.clear();
    for (const off of this.rooms.values()) off();
    this.rooms.clear();
    await Promise.all([...this.running]);
    await this.watcher?.close();
    this.watcher = null;
  }
}

/** The 1-based line where `needle` starts in `lines`, when it occurs exactly once. */
function findOnce(lines: string[], needle: string[]): number | null {
  if (needle.length === 0 || needle.length > lines.length) return null;
  let found: number | null = null;
  outer: for (let i = 0; i + needle.length <= lines.length; i++) {
    for (let j = 0; j < needle.length; j++) if (lines[i + j] !== needle[j]) continue outer;
    if (found !== null) return null;
    found = i + 1;
  }
  return found;
}

async function statKey(file: string): Promise<string | null> {
  try {
    const st = await stat(file);
    if (!st.isFile()) return null;
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return null;
    throw error;
  }
}
