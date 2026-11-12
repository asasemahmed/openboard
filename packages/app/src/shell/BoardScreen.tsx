/** Opens one board: checks it exists, connects, and shows it once the document has synced. */
import { useEffect, useReducer, useRef, useState } from 'react';
import { ApiError } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import { api, boards, rememberBoard, useBoards } from '../state/boards.js';
import { useStoreValue } from '../state/emitter.js';
import { currentActor } from '../state/identity.js';
import {
  CLOSE_BOARD_NOT_FOUND,
  CLOSE_STALE_DOCUMENT,
  INITIAL_LINEAGE,
  type LineageState,
  lineageReducer,
} from '../state/lineage.js';
import { type BoardSession, createSession } from '../state/session.js';
import { toasts } from '../state/toasts.js';
import { createWebsocketTransport } from '../state/transport.js';
import { Button } from '../ui/Button.js';
import { Icon } from '../ui/Icon.js';
import { BoardView } from './BoardView.js';
import { NewBoardDialog } from './NewBoardDialog.js';
import { ServerUnreachable, StateScreen } from './StateScreen.js';

const SLOW_MS = 4000;

interface BoardConnection {
  session: BoardSession | null;
  lineage: LineageState;
  dismiss(): void;
}

/**
 * The session for one board, with a fresh document whenever the server says
 * this tab's document is out of date (see state/lineage.ts).
 */
function useBoardSession(boardId: string, enabled: boolean): BoardConnection {
  const [state, dispatch] = useReducer(lineageReducer, INITIAL_LINEAGE);
  const [session, setSession] = useState<BoardSession | null>(null);

  // Read the lineage (again).
  useEffect(() => {
    if (!enabled || state.phase !== 'resolving') return;
    let live = true;
    const timer = setTimeout(() => {
      api
        .lineage(boardId)
        .then((lineage) => {
          if (live) dispatch({ type: 'lineage', lineage });
        })
        .catch((error: unknown) => {
          if (!live) return;
          const notFound = error instanceof ApiError && error.status === 404;
          dispatch({ type: 'lineage-failed', notFound });
        });
    }, state.retryInMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [enabled, boardId, state.phase, state.retryInMs]);

  useEffect(() => {
    if (state.phase !== 'waiting') return;
    const timer = setTimeout(() => dispatch({ type: 'retry' }), state.retryInMs);
    return () => clearTimeout(timer);
  }, [state.phase, state.retryInMs]);

  // One session per document generation.
  const generation = state.phase === 'connecting' ? state.generation : null;
  const lineage = state.lineage;
  useEffect(() => {
    if (!enabled || generation === null) return;
    const actor = currentActor();
    const next = createSession({
      boardId,
      actor,
      api,
      transport: (ydoc) => createWebsocketTransport(ydoc, boardId, actor, lineage),
    });
    setSession(next);
    rememberBoard(boardId);
    const off = next.connection.subscribe(() => {
      const c = next.connection.get();
      if (c.stale)
        dispatch({ type: 'closed', code: CLOSE_STALE_DOCUMENT, dirty: next.connection.dirty() });
      else if (c.gone) dispatch({ type: 'closed', code: CLOSE_BOARD_NOT_FOUND, dirty: false });
      else if (c.synced) dispatch({ type: 'synced' });
    });
    return () => {
      off();
      setSession(null);
      next.destroy();
    };
  }, [boardId, enabled, generation, lineage]);

  // A clean swap needs no more than a quiet note; lost edits get a notice that stays.
  const generations = useRef(0);
  const lostEdits = useRef(state.lostEdits);
  lostEdits.current = state.lostEdits;
  useEffect(() => {
    if (generation === null) return;
    generations.current++;
    if (generations.current > 1 && !lostEdits.current)
      toasts.show('This tab was out of date, so the board was loaded again from the server.');
  }, [generation]);

  return { session, lineage: state, dismiss: () => dispatch({ type: 'dismiss' }) };
}

/** Shown after a stale document with unsaved edits was replaced. Stays until dismissed. */
function LostEditsNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="lost-edits" role="alert">
      <Icon name="warning" />
      <p>
        <strong>This tab was out of date.</strong> The board on the server was replaced (another
        project, or its saved state was reset) while this tab was disconnected. Edits you made in
        that time were not applied; you are now looking at the server’s board.
      </p>
      <Button size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

function Connecting({ session }: { session: BoardSession }) {
  const ready = useStoreValue(session.store, () => session.store.meta.ready);
  const gone = useStoreValue(session.connection, () => session.connection.get().gone);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, []);
  if (gone) return <NotFound boardId={session.boardId} />;
  if (ready) return <BoardView session={session} />;
  return (
    <StateScreen title="Opening board…" busy>
      {slow && (
        <>
          <p>This is taking longer than usual. The server may be busy or restarting.</p>
          <Button icon="refresh" onClick={() => session.connection.reconnect()}>
            Try again
          </Button>
        </>
      )}
    </StateScreen>
  );
}

export function BoardScreen({ boardId }: { boardId: string }) {
  const list = useBoards();

  useEffect(() => {
    void boards.refresh();
  }, [boardId]);

  const known = list.boards.some((b) => b.id === boardId);
  const { session, lineage, dismiss } = useBoardSession(boardId, known);

  if (known && lineage.phase === 'gone') return <NotFound boardId={boardId} />;
  if (known && session)
    return (
      <>
        <Connecting key={lineage.generation} session={session} />
        {lineage.lostEdits && <LostEditsNotice onDismiss={dismiss} />}
      </>
    );
  if (list.status === 'error' && list.error.unreachable) {
    return <ServerUnreachable onRetry={() => void boards.refresh()} />;
  }
  if (list.status === 'error') {
    return (
      <StateScreen
        title="Could not load boards"
        actions={
          <Button icon="refresh" onClick={() => void boards.refresh()}>
            Try again
          </Button>
        }
      >
        <p>{list.error.message}</p>
      </StateScreen>
    );
  }
  if (list.status === 'loading' || known) return <StateScreen title="Opening board…" busy />;
  return <NotFound boardId={boardId} />;
}

function NotFound({ boardId }: { boardId: string }) {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <StateScreen
        title="Board not found"
        actions={
          <>
            <Button onClick={() => navigate('/')}>All boards</Button>
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              New board
            </Button>
          </>
        }
      >
        <p>
          There is no board with the id <code>{boardId}</code> in this project. It may have been
          renamed or deleted, or it lives in another project.
        </p>
      </StateScreen>
      <NewBoardDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
