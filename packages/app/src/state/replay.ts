/**
 * Replay: the board as it was after each batch of its history. The
 * controller holds the timeline (batches, oldest first, paged back to the
 * oldest point the server can rebuild), the position, play and pause, and
 * fetches snapshots: cached, the next one fetched ahead while playing, and a
 * request that no longer matters (the person scrubbed on) cancelled.
 *
 * Fetching and time are passed in, so it is tested without a server or timers.
 */
import type { Batch, Board } from '@openboard/core';
import { type Clock, systemClock } from './activity.js';
import { Emitter } from './emitter.js';

export type ReplaySpeed = 1 | 2 | 4;
export const REPLAY_SPEEDS: readonly ReplaySpeed[] = [1, 2, 4];
/** Time per step at 1×: calm enough to see what each batch did. */
export const STEP_MS = 1600;
const CACHE_MAX = 80;

export interface ReplayTimeline {
  /** Oldest first. */
  batches: Batch[];
  earliest: number;
}

export interface ReplayState {
  status: 'off' | 'loading' | 'ready' | 'error';
  ticks: readonly Batch[];
  /** Position on the timeline. */
  index: number;
  /** The snapshot shown, and the position it belongs to (it lags `index` while fetching). */
  snapshot: Board | null;
  shownIndex: number;
  fetching: boolean;
  playing: boolean;
  speed: ReplaySpeed;
  error: string | null;
}

export const REPLAY_OFF: ReplayState = Object.freeze({
  status: 'off',
  ticks: [],
  index: -1,
  snapshot: null,
  shownIndex: -1,
  fetching: false,
  playing: false,
  speed: 1,
  error: null,
});

export interface ReplayOptions {
  loadTimeline(): Promise<ReplayTimeline>;
  fetchSnapshot(cursor: number, signal: AbortSignal): Promise<Board>;
  clock?: Clock;
  stepMs?: number;
  describeError?: (error: unknown) => string;
}

interface Inflight {
  promise: Promise<Board>;
  controller: AbortController;
}

export class ReplayController extends Emitter {
  private state: ReplayState = REPLAY_OFF;
  private readonly opts: ReplayOptions;
  private readonly clock: Clock;
  private readonly cache = new Map<number, Board>();
  private readonly inflight = new Map<number, Inflight>();
  private timer: unknown = null;
  private session = 0;

  constructor(opts: ReplayOptions) {
    super();
    this.opts = opts;
    this.clock = opts.clock ?? systemClock;
  }

  readonly get = (): ReplayState => this.state;

  get active(): boolean {
    return this.state.status !== 'off';
  }

  /** Enter replay at the newest batch (or at `index`). */
  async open(index?: number): Promise<void> {
    const session = ++this.session;
    this.set({ ...REPLAY_OFF, status: 'loading', speed: this.state.speed });
    let timeline: ReplayTimeline;
    try {
      timeline = await this.opts.loadTimeline();
    } catch (error) {
      if (session === this.session)
        this.set({ ...this.state, status: 'error', error: this.describe(error) });
      return;
    }
    if (session !== this.session) return;
    const ticks = [...timeline.batches].sort((a, b) => a.cursor - b.cursor);
    this.set({ ...this.state, status: 'ready', ticks });
    if (ticks.length > 0) this.go(index ?? ticks.length - 1);
  }

  /** Leave replay. Cached snapshots are dropped; the next visit reads the history again. */
  close(): void {
    this.session++;
    this.stopTimer();
    for (const entry of this.inflight.values()) entry.controller.abort();
    this.inflight.clear();
    this.cache.clear();
    this.set({ ...REPLAY_OFF, speed: this.state.speed });
  }

  go(index: number): void {
    const { ticks } = this.state;
    if (ticks.length === 0) return;
    const next = Math.max(0, Math.min(ticks.length - 1, Math.round(index)));
    if (next !== this.state.index) this.set({ ...this.state, index: next });
    this.show(next);
  }

  step(delta: number): void {
    this.pause();
    this.go(this.state.index + delta);
  }

  home(): void {
    this.pause();
    this.go(0);
  }

  end(): void {
    this.pause();
    this.go(this.state.ticks.length - 1);
  }

  play(): void {
    const { ticks, index } = this.state;
    if (ticks.length < 2) return;
    // Playing from the end starts over.
    if (index >= ticks.length - 1) this.go(0);
    this.set({ ...this.state, playing: true });
    if (this.state.shownIndex === this.state.index) this.afterShown();
  }

  pause(): void {
    if (!this.state.playing) return;
    this.stopTimer();
    this.set({ ...this.state, playing: false });
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: ReplaySpeed): void {
    if (speed === this.state.speed) return;
    this.set({ ...this.state, speed });
    if (this.state.playing) this.schedule();
  }

  destroy(): void {
    this.close();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private set(next: ReplayState): void {
    this.state = next;
    this.emit();
  }

  private describe(error: unknown): string {
    if (this.opts.describeError) return this.opts.describeError(error);
    return error instanceof Error ? error.message : String(error);
  }

  private cursorAt(index: number): number | undefined {
    return this.state.ticks[index]?.cursor;
  }

  private show(index: number): void {
    const cursor = this.cursorAt(index);
    if (cursor === undefined) return;
    const keep = new Set([cursor]);
    const ahead = this.state.playing ? this.cursorAt(index + 1) : undefined;
    if (ahead !== undefined) keep.add(ahead);
    // Whatever was being fetched for a position the person has left is not needed any more.
    for (const [c, entry] of this.inflight) {
      if (keep.has(c)) continue;
      entry.controller.abort();
      this.inflight.delete(c);
    }
    const cached = this.cache.get(cursor);
    if (cached) {
      this.set({
        ...this.state,
        snapshot: cached,
        shownIndex: index,
        fetching: false,
        error: null,
      });
      this.afterShown();
      return;
    }
    this.set({ ...this.state, fetching: true });
    const session = this.session;
    this.fetch(cursor).then(
      (board) => {
        if (session !== this.session || this.state.index !== index) return;
        this.set({
          ...this.state,
          snapshot: board,
          shownIndex: index,
          fetching: false,
          error: null,
        });
        this.afterShown();
      },
      (error: unknown) => {
        if (session !== this.session || this.state.index !== index) return;
        if (isAbort(error)) return;
        this.set({ ...this.state, fetching: false, playing: false, error: this.describe(error) });
        this.stopTimer();
      },
    );
  }

  private fetch(cursor: number): Promise<Board> {
    const cached = this.cache.get(cursor);
    if (cached) return Promise.resolve(cached);
    const running = this.inflight.get(cursor);
    if (running) return running.promise;
    const controller = new AbortController();
    const promise = this.opts.fetchSnapshot(cursor, controller.signal).then((board) => {
      this.inflight.delete(cursor);
      this.remember(cursor, board);
      return board;
    });
    promise.catch(() => {
      if (this.inflight.get(cursor)?.controller === controller) this.inflight.delete(cursor);
    });
    this.inflight.set(cursor, { promise, controller });
    return promise;
  }

  private remember(cursor: number, board: Board): void {
    this.cache.set(cursor, board);
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private afterShown(): void {
    if (!this.state.playing) return;
    const ahead = this.cursorAt(this.state.index + 1);
    if (ahead !== undefined) void this.fetch(ahead).catch(() => {});
    this.schedule();
  }

  private schedule(): void {
    this.stopTimer();
    if (!this.state.playing) return;
    // Wait for the current step to be on screen before counting its time.
    if (this.state.shownIndex !== this.state.index) return;
    const wait = (this.opts.stepMs ?? STEP_MS) / this.state.speed;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (!this.state.playing) return;
      if (this.state.index >= this.state.ticks.length - 1) {
        this.set({ ...this.state, playing: false });
        return;
      }
      this.go(this.state.index + 1);
    }, wait);
  }

  private stopTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error &&
      (error.name === 'AbortError' || (error as { code?: string }).code === 'aborted')) ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'aborted')
  );
}

/** Read the history back to the oldest point the server can rebuild, oldest first. */
export async function loadReplayTimeline(
  page: (before: number | undefined) => Promise<{ batches: Batch[]; earliest: number }>,
  max = 2000,
  pageSize = 200,
): Promise<ReplayTimeline> {
  const out: Batch[] = [];
  let before: number | undefined;
  let earliest = 0;
  for (;;) {
    const result = await page(before);
    earliest = result.earliest;
    // A batch whose cursor is at or before `earliest` cannot be rebuilt.
    const usable = result.batches.filter((b) => b.cursor >= earliest);
    out.push(...usable);
    const oldest = result.batches[result.batches.length - 1];
    if (
      !oldest ||
      result.batches.length < pageSize ||
      oldest.cursor <= earliest ||
      out.length >= max
    )
      break;
    before = oldest.cursor;
  }
  const unique = new Map(out.map((b) => [b.id, b]));
  return {
    batches: [...unique.values()].sort((a, b) => a.cursor - b.cursor).slice(-max),
    earliest,
  };
}
