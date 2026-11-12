/**
 * Comparing the live board with a git revision of its file, in the read-only
 * shell replay uses: the current board, marked with what changed since the
 * revision, removed nodes drawn as ghosts where they were, a legend with
 * counts, and the list of changes.
 */
import { type Board, BoardDoc, diffBoards } from '@openboard/core';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { type KeyboardEvent, useEffect, useState } from 'react';
import { reducedMotion, useBoardActions } from '../canvas/actions.js';
import { Canvas } from '../canvas/Canvas.js';
import { plainLine } from '../lib/agents.js';
import { calmMessage } from '../lib/api.js';
import {
  type DiffEntry,
  type DiffKind,
  type DiffView,
  deriveDiffView,
  diffSummary,
} from '../lib/diffView.js';
import { saveBlob } from '../lib/download.js';
import type { CompareTarget } from '../lib/revisions.js';
import { useTheme } from '../lib/theme.js';
import { SessionProvider, useSession } from '../state/context.js';
import { useValue } from '../state/emitter.js';
import { type BoardSession, createSession } from '../state/session.js';
import { toasts } from '../state/toasts.js';
import { createLocalTransport } from '../state/transport.js';
import { Button } from '../ui/Button.js';
import { Icon } from '../ui/Icon.js';

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; session: BoardSession; view: DiffView };

const KIND_NAME: Record<DiffKind, string> = {
  added: 'Added',
  updated: 'Changed',
  moved: 'Moved',
  removed: 'Removed',
};

/** Build the read-only comparison: the live board now, against the revision's file. */
function useComparison(live: BoardSession, target: CompareTarget, version: number): Load {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    let session: BoardSession | null = null;
    const after: Board = live.doc.toJSON();
    live.api
      .boardAtRevision(live.boardId, target.rev)
      .then((before) => {
        if (!alive) return;
        // The same diff the server makes, against the very board shown, so they always agree.
        const view = deriveDiffView(diffBoards(before, after), before, after);
        session = createSession({
          boardId: live.boardId,
          actor: live.actor(),
          api: live.api,
          transport: (ydoc) => createLocalTransport(ydoc),
          doc: BoardDoc.fromJSON(after),
          readOnly: true,
        });
        session.store.setGhosts({ nodes: view.ghostNodes, edges: view.ghostEdges });
        session.ui.diff.set(view);
        setLoad({ status: 'ready', session, view });
      })
      .catch((error: unknown) => {
        if (alive) setLoad({ status: 'error', message: calmMessage(error) });
      });
    return () => {
      alive = false;
      session?.destroy();
    };
  }, [live, target.rev, version]);
  return load;
}

export function CompareView() {
  const live = useSession();
  const target = useValue(live.ui.compare);
  if (!target) return null;
  return <Comparison key={target.rev} target={target} />;
}

function Comparison({ target }: { target: CompareTarget }) {
  const live = useSession();
  const [version, setVersion] = useState(0);
  const [changed, setChanged] = useState(false);
  const load = useComparison(live, target, version);
  const exit = () => live.ui.compare.set(null);
  // The comparison is of the board as it was when it opened; say so when it moves on.
  useEffect(() => {
    setChanged(false);
    return live.doc.observe((event) => {
      if (event.changes.length > 0 || event.comments) setChanged(true);
    });
  }, [live, version]);
  const refresh = () => {
    setChanged(false);
    setVersion((v) => v + 1);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      exit();
    }
  };
  return (
    <section
      className="replay compare"
      aria-label="Comparison with a git revision"
      onKeyDown={onKeyDown}
    >
      <CompareBanner
        target={target}
        view={load.status === 'ready' ? load.view : null}
        onExit={exit}
        {...(changed ? { onRefresh: refresh } : {})}
      />
      {load.status === 'ready' ? (
        <SessionProvider session={load.session}>
          <ReactFlowProvider>
            <div className="compare-body">
              <div className="replay-canvas">
                <CompareCanvas />
              </div>
              <ChangeList view={load.view} rev={target.rev} />
            </div>
          </ReactFlowProvider>
        </SessionProvider>
      ) : (
        <div className="replay-wait">
          {load.status === 'error' ? (
            <p className="inline-error">{load.message}</p>
          ) : (
            <p className="muted">Reading the board at {target.short}…</p>
          )}
        </div>
      )}
    </section>
  );
}

function CompareCanvas() {
  const actions = useBoardActions();
  return <Canvas actions={actions} readOnly />;
}

export function CompareBanner({
  target,
  view,
  onExit,
  onRefresh,
}: {
  target: CompareTarget;
  view: DiffView | null;
  onExit: () => void;
  /** Given when the live board changed since the comparison was made. */
  onRefresh?: () => void;
}) {
  return (
    <header className="replay-banner" role="status">
      <Icon name="history" />
      <div className="replay-banner-text">
        <strong>
          Comparing with {target.short} — {plainLine(target.subject, 80)}
        </strong>
        <span className="replay-banner-step">
          {view
            ? `Since then: ${diffSummary(view.counts).toLowerCase()}.`
            : 'Reading the revision…'}
        </span>
        <span className="replay-banner-note">
          This shows the board now. Nothing here can be edited.
        </span>
      </div>
      {onRefresh && (
        <span className="compare-stale">
          Board changed
          <Button size="sm" icon="refresh" onClick={onRefresh}>
            Refresh comparison
          </Button>
        </span>
      )}
      <Button variant="primary" size="sm" onClick={onExit}>
        Back to live
      </Button>
    </header>
  );
}

function ChangeList({ view, rev }: { view: DiffView; rev: string }) {
  const session = useSession();
  const flow = useReactFlow();
  const only = useValue(session.ui.onlyChanges);
  const { resolved } = useTheme();
  const [busy, setBusy] = useState(false);
  const groups = (['added', 'updated', 'moved', 'removed'] as const)
    .map((kind) => ({ kind, entries: view.entries.filter((e) => e.kind === kind) }))
    .filter((g) => g.entries.length > 0);

  const pan = (entry: DiffEntry) => {
    void flow.fitView({
      nodes: entry.nodeIds.map((id) => ({ id })),
      duration: reducedMotion() ? 0 : 260,
      padding: 0.4,
      maxZoom: 1.1,
    });
  };

  const download = async () => {
    setBusy(true);
    try {
      const file = await session.api.exportBoard(session.boardId, {
        format: 'svg',
        diffFrom: rev,
        theme: resolved,
      });
      saveBlob(file.blob, file.filename);
    } catch (error) {
      toasts.show(calmMessage(error), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="compare-side" aria-label="Changes since the revision">
      <ul className="diff-legend">
        {(['added', 'updated', 'moved', 'removed'] as const).map((kind) => (
          <li key={kind} className={`diff-${kind}`}>
            <span className="diff-swatch" aria-hidden="true" />
            {KIND_NAME[kind]} <strong>{view.counts[kind]}</strong>
          </li>
        ))}
      </ul>
      <div className="compare-tools">
        <label className="check-label">
          <input
            type="checkbox"
            checked={only}
            onChange={(event) => session.ui.onlyChanges.set(event.target.checked)}
          />
          Show only changes
        </label>
        <Button size="sm" icon="file" disabled={busy} onClick={() => void download()}>
          Download diff as SVG
        </Button>
      </div>
      {groups.length === 0 ? (
        <p className="panel-note muted">Nothing changed since this revision.</p>
      ) : (
        groups.map((group) => (
          <section key={group.kind} className="diff-group">
            <h3>
              {KIND_NAME[group.kind]} ({group.entries.length})
            </h3>
            <ul>
              {group.entries.map((entry) => (
                <li key={`${entry.kind}-${entry.id}`}>
                  <button
                    type="button"
                    className={`diff-item diff-${entry.kind}`}
                    onClick={() => pan(entry)}
                  >
                    <span className="diff-swatch" aria-hidden="true" />
                    {plainLine(entry.title, 60)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </aside>
  );
}
