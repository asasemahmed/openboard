/**
 * Replay: the board as it was after a chosen batch of its history, over the
 * live workspace (which keeps syncing underneath). The canvas is read-only
 * and shows a snapshot from the server; a banner says plainly that this is
 * the past, and a timeline at the bottom scrubs and plays through it.
 */
import { type Batch, type Board, BoardDoc } from '@openboard/core';
import { ReactFlowProvider } from '@xyflow/react';
import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useBoardActions } from '../canvas/actions.js';
import { Canvas } from '../canvas/Canvas.js';
import { plainLine } from '../lib/agents.js';
import { absoluteTime } from '../lib/time.js';
import { SessionProvider, useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { REPLAY_SPEEDS, type ReplaySpeed, type ReplayState } from '../state/replay.js';
import { type BoardSession, createSession } from '../state/session.js';
import { createLocalTransport } from '../state/transport.js';
import { Button, IconButton } from '../ui/Button.js';
import { Icon } from '../ui/Icon.js';

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
}

/** A read-only session holding the shown snapshot, updated in place step by step. */
function useReplaySession(live: BoardSession, snapshot: Board | null): BoardSession | null {
  const [session, setSession] = useState<BoardSession | null>(null);
  const ref = useRef<BoardSession | null>(null);
  useEffect(
    () => () => {
      ref.current?.destroy();
      ref.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!snapshot) return;
    if (!ref.current) {
      const doc = BoardDoc.fromJSON(snapshot);
      ref.current = createSession({
        boardId: live.boardId,
        actor: live.actor(),
        api: live.api,
        transport: (ydoc) => createLocalTransport(ydoc),
        doc,
        readOnly: true,
      });
      setSession(ref.current);
    } else {
      ref.current.doc.reconcile(snapshot, ref.current.doc.origin('system', 'file'));
    }
  }, [snapshot, live]);
  return session;
}

export function ReplayView() {
  const live = useSession();
  const { replay } = live;
  const state = useStoreValue(replay, replay.get);
  const session = useReplaySession(live, state.snapshot);
  const shown = state.ticks[state.shownIndex];
  const previous = useRef<Board | null>(null);

  // Point at what the shown step changed, the way live changes are pointed at.
  useEffect(() => {
    const before = previous.current;
    previous.current = state.snapshot;
    if (!session || !shown || !state.snapshot) return;
    const nodes = shown.nodeIds
      .filter((id) => state.snapshot?.nodes[id])
      .map((id) => ({
        kind: 'node' as const,
        id,
        verb: before && !before.nodes[id] ? ('added' as const) : ('updated' as const),
      }));
    const edges = shown.edgeIds
      .filter((id) => state.snapshot?.edges[id])
      .map((id) => ({ kind: 'edge' as const, id, verb: 'updated' as const }));
    session.activity.flash([...nodes, ...edges], shown.actor);
  }, [session, shown, state.snapshot]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (target.closest('select, input, textarea')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      replay.close();
    } else if (event.key === ' ' && !target.closest('button')) {
      event.preventDefault();
      replay.toggle();
    }
  };

  return (
    <section className="replay" aria-label="Replay of the board's history" onKeyDown={onKeyDown}>
      <ReplayBanner state={state} onExit={() => replay.close()} />
      <div className="replay-canvas">
        {session ? (
          <SessionProvider session={session}>
            <ReactFlowProvider>
              <ReplayCanvas />
            </ReactFlowProvider>
          </SessionProvider>
        ) : (
          <div className="replay-wait">
            {state.status === 'error' ? (
              <p className="inline-error">{state.error}</p>
            ) : state.status === 'ready' && state.ticks.length === 0 ? (
              <p className="muted">There is no history to replay yet.</p>
            ) : (
              <p className="muted">Loading the history…</p>
            )}
          </div>
        )}
      </div>
      <Timeline state={state} />
    </section>
  );
}

function ReplayCanvas() {
  const actions = useBoardActions();
  return <Canvas actions={actions} readOnly />;
}

export function ReplayBanner({ state, onExit }: { state: ReplayState; onExit: () => void }) {
  const { store } = useSession();
  const actors = useStoreValue(store, () => store.meta.actors);
  const batch = state.ticks[state.index];
  const name = batch
    ? (actors[batch.actor]?.name ?? (batch.actor === 'system' ? 'OpenBoard' : batch.actor))
    : '';
  return (
    <header className="replay-banner" role="status">
      <Icon name="history" />
      <div className="replay-banner-text">
        <strong>{batch ? `Replay: the board on ${when(batch.at)}` : 'Replay'}</strong>
        {batch && (
          <span className="replay-banner-step">
            Step {state.index + 1} of {state.ticks.length}: {name}, {plainLine(batch.summary, 80)}
          </span>
        )}
        <span className="replay-banner-note">This is the past. Nothing here can be edited.</span>
      </div>
      {state.fetching && <span className="replay-loading">Loading…</span>}
      <Button variant="primary" size="sm" onClick={onExit}>
        Back to live
      </Button>
    </header>
  );
}

const KIND_CLASS: Record<string, string> = {
  human: 'tick-human',
  agent: 'tick-agent',
  system: 'tick-system',
};

function Timeline({ state }: { state: ReplayState }) {
  const { replay, store } = useSession();
  const actors = useStoreValue(store, () => store.meta.actors);
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);
  const speedId = useId();
  const n = state.ticks.length;
  // Replay takes the keyboard: arrows scrub from the start.
  useEffect(() => {
    track.current?.focus({ preventScroll: true });
  }, []);
  const at = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);

  const indexAt = (clientX: number): number => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || n === 0) return 0;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(ratio * (n - 1));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (n === 0) return;
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    replay.pause();
    replay.go(indexAt(event.clientX));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const i = indexAt(event.clientX);
    setHover(i);
    if (dragging.current) replay.go(i);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, () => void> = {
      ArrowRight: () => replay.step(1),
      ArrowUp: () => replay.step(1),
      ArrowLeft: () => replay.step(-1),
      ArrowDown: () => replay.step(-1),
      PageUp: () => replay.step(10),
      PageDown: () => replay.step(-10),
      Home: () => replay.home(),
      End: () => replay.end(),
    };
    const run = keys[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  };

  const ticks = useMemo(
    () =>
      state.ticks.map((batch, i) => ({
        batch,
        left: at(i),
        kind: actors[batch.actor]?.kind ?? (batch.actor === 'system' ? 'system' : 'human'),
      })),
    [state.ticks, actors],
  );
  const current = state.ticks[state.index];
  const hovered = hover !== null ? state.ticks[hover] : undefined;

  return (
    <footer className="replay-timeline">
      <div className="replay-controls">
        <IconButton
          icon="arrowLeft"
          label="Previous step"
          disabled={state.index <= 0}
          onClick={() => replay.step(-1)}
        />
        <Button
          size="sm"
          variant="primary"
          icon={state.playing ? 'pause' : 'play'}
          disabled={n < 2}
          onClick={() => replay.toggle()}
        >
          {state.playing ? 'Pause' : 'Play'}
        </Button>
        <IconButton
          icon="arrowRight"
          label="Next step"
          disabled={state.index >= n - 1}
          onClick={() => replay.step(1)}
        />
        <label htmlFor={speedId} className="visually-hidden">
          Speed
        </label>
        <select
          id={speedId}
          className="input input-sm replay-speed"
          value={state.speed}
          onChange={(event) => replay.setSpeed(Number(event.target.value) as ReplaySpeed)}
        >
          {REPLAY_SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </div>
      <div className="replay-track-wrap">
        <div
          ref={track}
          className="replay-track"
          role="slider"
          tabIndex={0}
          aria-label="Point in history"
          aria-valuemin={1}
          aria-valuemax={Math.max(1, n)}
          aria-valuenow={state.index + 1}
          aria-valuetext={
            current ? `${when(current.at)}: ${plainLine(current.summary, 80)}` : 'No history'
          }
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKeyDown}
        >
          {ticks.map((t) => (
            <span
              key={t.batch.id}
              className={`replay-tick ${KIND_CLASS[t.kind] ?? 'tick-human'}`}
              style={{ left: `${t.left}%` }}
            />
          ))}
          {state.index >= 0 && (
            <span
              className="replay-thumb"
              style={{ left: `${at(state.index)}%` }}
              aria-hidden="true"
            />
          )}
        </div>
        {hovered && hover !== null && (
          <TickCard
            batch={hovered}
            left={at(hover)}
            name={actors[hovered.actor]?.name ?? hovered.actor}
          />
        )}
      </div>
      <p className="replay-legend" aria-hidden="true">
        <span className="tick-key tick-human" /> people <span className="tick-key tick-agent" />{' '}
        agents <span className="tick-key tick-system" /> OpenBoard
      </p>
    </footer>
  );
}

function TickCard({ batch, left, name }: { batch: Batch; left: number; name: string }) {
  return (
    <div className="replay-tick-card" style={{ left: `${left}%` }} role="tooltip">
      <p>
        <strong>{name}</strong> <time dateTime={batch.at}>{absoluteTime(batch.at)}</time>
      </p>
      <p>{plainLine(batch.summary, 100)}</p>
      {batch.reason && <p className="muted">{plainLine(batch.reason, 120)}</p>}
    </div>
  );
}
