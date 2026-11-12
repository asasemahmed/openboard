/**
 * Keeping a tab's document on the right board. The sync socket needs the
 * live document's lineage; when the server closes it with
 * `CLOSE_STALE_DOCUMENT`, this tab's document belongs to an older or a
 * different project, so it is thrown away (never merged), the lineage is read
 * again, and a fresh document connects.
 *
 * The rules are a pure reducer, so they are tested without sockets; the
 * board screen runs the effects (fetching the lineage, building a session).
 *
 *   resolving   reading the lineage
 *   connecting  a session with this lineage exists and is connecting or live
 *   waiting     reading the lineage failed; retry after `retryInMs`
 *   gone        the board does not exist
 */

/** WebSocket close code: the board does not exist. */
export const CLOSE_BOARD_NOT_FOUND = 4404;
/** WebSocket close code: the document belongs to another lineage. */
export const CLOSE_STALE_DOCUMENT = 4409;
/** WebSocket close code: the connection's access was revoked, expired or signed out. */
export const CLOSE_ACCESS_REVOKED = 4401;

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 8000;

export type LineagePhase = 'resolving' | 'connecting' | 'waiting' | 'gone';

export interface LineageState {
  phase: LineagePhase;
  lineage: string | null;
  /** Grows with every fresh document, so each gets its own session. */
  generation: number;
  /** Failed lineage reads or stale closes in a row, for backing off. */
  failures: number;
  /** Set when a stale document had edits the server never saw. Shown until dismissed. */
  lostEdits: boolean;
  /** How long to wait before the next lineage read (`waiting`, or a quick repeat of `stale`). */
  retryInMs: number;
}

export type LineageEvent =
  | { type: 'lineage'; lineage: string | null }
  | { type: 'lineage-failed'; notFound: boolean }
  | { type: 'retry' }
  | { type: 'synced' }
  | { type: 'closed'; code: number; dirty: boolean }
  | { type: 'dismiss' };

export const INITIAL_LINEAGE: LineageState = Object.freeze({
  phase: 'resolving',
  lineage: null,
  generation: 0,
  failures: 0,
  lostEdits: false,
  retryInMs: 0,
});

function backoff(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, failures - 1));
}

export function lineageReducer(state: LineageState, event: LineageEvent): LineageState {
  switch (event.type) {
    case 'lineage':
      if (state.phase !== 'resolving') return state;
      return {
        ...state,
        phase: 'connecting',
        lineage: event.lineage,
        generation: state.generation + 1,
        retryInMs: 0,
      };
    case 'lineage-failed':
      if (state.phase !== 'resolving') return state;
      if (event.notFound) return { ...state, phase: 'gone' };
      return {
        ...state,
        phase: 'waiting',
        failures: state.failures + 1,
        retryInMs: backoff(state.failures + 1),
      };
    case 'retry':
      return state.phase === 'waiting' ? { ...state, phase: 'resolving' } : state;
    case 'synced':
      return state.failures === 0 ? state : { ...state, failures: 0, retryInMs: 0 };
    case 'closed':
      if (state.phase !== 'connecting') return state;
      if (event.code === CLOSE_BOARD_NOT_FOUND) return { ...state, phase: 'gone' };
      if (event.code !== CLOSE_STALE_DOCUMENT) return state;
      // A fresh document right away; only a stale close straight after another one waits.
      return {
        ...state,
        phase: 'resolving',
        lineage: null,
        failures: state.failures + 1,
        lostEdits: state.lostEdits || event.dirty,
        retryInMs: state.failures === 0 ? 0 : backoff(state.failures),
      };
    case 'dismiss':
      return state.lostEdits ? { ...state, lostEdits: false } : state;
  }
}
