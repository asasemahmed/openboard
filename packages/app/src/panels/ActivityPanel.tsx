/**
 * The board's history, newest first, from the server's history route: who
 * changed what and why, with undo and redo per change. It pages backwards on
 * scroll and refreshes shortly after the board changes, only while open.
 */
import type { Batch } from '@openboard/core';
import { useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { reducedMotion } from '../canvas/actions.js';
import { calmMessage } from '../lib/api.js';
import {
  BADGE_LABEL,
  type HistoryRow,
  historyRow,
  mergeBatches,
  replaceNewest,
  undoableBy,
  undoOutcome,
} from '../lib/historyRows.js';
import { absoluteTime, relativeTime } from '../lib/time.js';
import { useCan } from '../state/access.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { undoBatch } from '../state/review.js';
import type { BoardSession } from '../state/session.js';
import { toasts } from '../state/toasts.js';
import { Avatar } from '../ui/Avatar.js';
import { Button } from '../ui/Button.js';
import { Icon } from '../ui/Icon.js';

const PAGE = 40;
const MAX_PAGE = 200;
const REFRESH_MS = 700;

interface Filters {
  actor: string;
  includeMoves: boolean;
}

function useHistory(session: BoardSession, filters: Filters) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const rows = useRef<Batch[]>([]);
  rows.current = batches;
  const generation = useRef(0);

  const options = useCallback(
    (extra: { limit: number; before?: number }) => ({
      ...extra,
      maxTokens: 50_000,
      includeMoves: filters.includeMoves,
      ...(filters.actor ? { actor: filters.actor } : {}),
    }),
    [filters.actor, filters.includeMoves],
  );

  /**
   * Re-read every row shown, page by page, so changes to older rows (an undo
   * by someone else marks them undone) show up too.
   */
  const refresh = useCallback(async () => {
    const gen = generation.current;
    const wanted = Math.max(PAGE, rows.current.length);
    const fresh: Batch[] = [];
    let before: number | undefined;
    let complete = false;
    try {
      while (fresh.length < wanted) {
        const limit = Math.min(MAX_PAGE, wanted - fresh.length);
        const result = await session.api.history(
          session.boardId,
          options(before === undefined ? { limit } : { limit, before }),
        );
        if (gen !== generation.current) return;
        fresh.push(...result.batches);
        const last = result.batches[result.batches.length - 1];
        if (result.batches.length < limit || !last) {
          complete = true;
          break;
        }
        before = last.cursor;
      }
      setBatches((current) => replaceNewest(current, fresh, complete));
      if (complete) setMore(false);
      setStatus('ready');
      setError(null);
    } catch (err) {
      if (gen !== generation.current) return;
      setStatus((s) => (s === 'loading' ? 'error' : s));
      setError(calmMessage(err));
    }
  }, [session, options]);

  const loadOlder = useCallback(async () => {
    const oldest = rows.current[rows.current.length - 1];
    if (!oldest || !more) return;
    const gen = generation.current;
    try {
      const result = await session.api.history(
        session.boardId,
        options({ limit: PAGE, before: oldest.cursor }),
      );
      if (gen !== generation.current) return;
      setBatches((current) => mergeBatches(current, result.batches));
      setMore(result.batches.length >= PAGE);
    } catch (err) {
      setError(calmMessage(err));
    }
  }, [session, options, more]);

  // A new filter starts over.
  useEffect(() => {
    generation.current++;
    rows.current = [];
    setBatches([]);
    setMore(true);
    setStatus('loading');
    void refresh();
  }, [refresh]);

  // The board changed: read the newest rows again once it settles.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = session.doc.observe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), REFRESH_MS);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [session, refresh]);

  return { batches, status, error, more, refresh, loadOlder };
}

/** Ask, then undo everything an actor did that is still in place. */
export async function confirmUndoAll(session: BoardSession, actorId: string): Promise<void> {
  const name = session.store.meta.actors[actorId]?.name ?? actorId;
  let count = 0;
  try {
    const result = await session.api.history(session.boardId, {
      actor: actorId,
      limit: MAX_PAGE,
      includeMoves: true,
      maxTokens: 50_000,
    });
    count = undoableBy(result.batches, actorId).length;
  } catch (err) {
    toasts.show(calmMessage(err), { tone: 'error' });
    return;
  }
  if (count === 0) {
    toasts.show(`Nothing by ${name} is left to undo.`);
    return;
  }
  session.ui.confirm.set({
    title: `Undo everything by ${name}?`,
    body: `This reverts ${count === 1 ? '1 change' : `${count} changes`} by ${name} that ${count === 1 ? 'is' : 'are'} still in place. Anything changed since is left as it is. You can redo each one from the activity panel.`,
    actions: [
      { label: 'Cancel', run: () => {} },
      {
        label: `Undo ${count === 1 ? '1 change' : `${count} changes`}`,
        tone: 'danger',
        run: () => {
          void undoBatch(session, { actorId, scope: 'all' }).then((result) => {
            if (!result.ok) toasts.show(result.message, { tone: 'error' });
            else toasts.show(undoOutcome(result.value), { ms: 6000 });
          });
        },
      },
    ],
  });
}

export function ActivityPanel() {
  const session = useSession();
  const actors = useStoreValue(session.store, () => session.store.meta.actors);
  const [filters, setFilters] = useState<Filters>({ actor: '', includeMoves: false });
  const canUndo = useCan('board.undo');
  const history = useHistory(session, filters);
  const sentinel = useRef<HTMLDivElement>(null);
  const actorFieldId = useId();
  const people = Object.values(actors)
    .filter((a) => a.kind !== 'system')
    .sort((a, b) => a.name.localeCompare(b.name));

  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void history.loadOlder();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [history.loadOlder]);

  const filterName = filters.actor ? (actors[filters.actor]?.name ?? filters.actor) : null;

  return (
    <div className="activity-panel">
      <div className="panel-toolbar activity-filters">
        <label htmlFor={actorFieldId} className="visually-hidden">
          Show changes by
        </label>
        <select
          id={actorFieldId}
          className="input input-sm"
          value={filters.actor}
          onChange={(event) => setFilters((f) => ({ ...f, actor: event.target.value }))}
        >
          <option value="">Everyone</option>
          {people.map((a) => (
            <option key={a.id} value={a.id}>
              {a.kind === 'agent' ? `${a.name} (agent)` : a.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          icon="play"
          title="Watch the board change, batch by batch"
          onClick={() => void session.replay.open()}
        >
          Replay
        </Button>
        <Button
          size="sm"
          icon="history"
          title="See what changed since a git commit of the board"
          onClick={() => session.ui.comparePicker.set(true)}
        >
          Compare
        </Button>
        <label className="check-label">
          <input
            type="checkbox"
            checked={filters.includeMoves}
            onChange={(event) => setFilters((f) => ({ ...f, includeMoves: event.target.checked }))}
          />
          Moves and layout
        </label>
      </div>
      {filters.actor && canUndo && (
        <div className="activity-actor-bar">
          <Button
            size="sm"
            variant="danger"
            icon="undo"
            onClick={() => void confirmUndoAll(session, filters.actor)}
          >
            Undo everything by {filterName}…
          </Button>
        </div>
      )}
      {history.status === 'loading' && history.batches.length === 0 && (
        <p className="panel-note muted">Loading history…</p>
      )}
      {history.status === 'error' && history.batches.length === 0 && (
        <div className="panel-note">
          <p className="inline-error">{history.error}</p>
          <Button size="sm" icon="refresh" onClick={() => void history.refresh()}>
            Try again
          </Button>
        </div>
      )}
      {history.status === 'ready' && history.batches.length === 0 && (
        <div className="panel-empty">
          <Icon name="history" size={20} />
          <p>
            {filterName
              ? `${filterName} has not changed anything yet.`
              : 'Every change to the board lands here, by people and agents alike, with a way to undo it.'}
          </p>
        </div>
      )}
      <ol className="history-list">
        {history.batches.map((batch) => (
          <HistoryItem key={batch.id} row={historyRow(batch)} onChanged={history.refresh} />
        ))}
      </ol>
      {history.more && history.batches.length > 0 && (
        <div ref={sentinel} className="history-more">
          <Button size="sm" variant="ghost" onClick={() => void history.loadOlder()}>
            Show older
          </Button>
        </div>
      )}
    </div>
  );
}

function HistoryItem({ row, onChanged }: { row: HistoryRow; onChanged: () => void }) {
  const session = useSession();
  const { store, ui } = session;
  const flow = useReactFlow();
  const actor = useStoreValue(store, () => store.meta.actors[row.batch.actor]);
  const name = actor?.name ?? (row.batch.actor === 'system' ? 'OpenBoard' : row.batch.actor);
  const [busy, setBusy] = useState(false);
  const canUndo = useCan('board.undo');
  const [result, setResult] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const existing = () => row.nodeIds.filter((id) => store.node(id));

  const run = async () => {
    if (!row.action) return;
    setBusy(true);
    const outcome = await undoBatch(session, { batchId: row.action.batchId });
    setBusy(false);
    if (!outcome.ok) setResult({ text: outcome.message, tone: 'error' });
    else {
      setResult({
        text: undoOutcome(outcome.value, row.action.kind === 'redo' ? 'Redone' : 'Undone'),
        tone: outcome.value.conflicts.length ? 'error' : 'info',
      });
      onChanged();
    }
  };

  const fit = () => {
    const ids = existing();
    if (ids.length === 0) return;
    ui.pauseFollow();
    void flow.fitView({
      nodes: ids.map((id) => ({ id })),
      duration: reducedMotion() ? 0 : 280,
      padding: 0.3,
      maxZoom: 1.1,
    });
  };

  return (
    <li
      className={`history-row${row.batch.undoneBy ? ' is-undone' : ''}`}
      onPointerEnter={() => ui.pointAt(existing())}
      onPointerLeave={() => ui.pointAt([])}
    >
      {actor ? <Avatar actor={actor} size={22} /> : <span className="avatar-blank" />}
      <div className="history-main">
        <button
          type="button"
          className="history-summary"
          onClick={fit}
          onFocus={() => ui.pointAt(existing())}
          onBlur={() => ui.pointAt([])}
          title={row.nodeIds.length ? 'Show on the canvas' : undefined}
        >
          <span className="history-who">
            <strong>{name}</strong>
            {actor?.kind === 'agent' && (
              <span className="author-mark" role="img" aria-label="agent" title="Agent">
                <Icon name="agent" size={13} />
              </span>
            )}
            <time dateTime={row.batch.at} title={absoluteTime(row.batch.at)}>
              {relativeTime(row.batch.at)}
            </time>
          </span>
          <span className="history-text">{row.batch.summary}</span>
          {row.batch.reason && <span className="history-reason">{row.batch.reason}</span>}
        </button>
        {(row.badges.length > 0 || row.action) && (
          <div className="history-foot">
            {row.badges.map((badge) => (
              <span key={badge} className={`badge badge-${badge}`}>
                {BADGE_LABEL[badge]}
              </span>
            ))}
            {row.action && canUndo && (
              <Button
                size="sm"
                variant="ghost"
                icon={row.action.kind === 'undo' ? 'undo' : 'redo'}
                className="history-action"
                disabled={busy}
                onClick={() => void run()}
              >
                {row.action.kind === 'undo' ? 'Undo' : 'Redo'}
              </Button>
            )}
          </div>
        )}
        {result && (
          <p className={result.tone === 'error' ? 'inline-error' : 'inline-ok'} role="status">
            {result.text}
          </p>
        )}
      </div>
    </li>
  );
}
