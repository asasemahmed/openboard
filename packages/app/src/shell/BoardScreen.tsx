/** Opens one board: checks it exists, connects, and shows it once the document has synced. */
import { useEffect, useState } from 'react';
import { navigate } from '../lib/router.js';
import { api, boards, rememberBoard, useBoards } from '../state/boards.js';
import { useStoreValue } from '../state/emitter.js';
import { currentActor } from '../state/identity.js';
import { type BoardSession, createSession } from '../state/session.js';
import { createWebsocketTransport } from '../state/transport.js';
import { Button } from '../ui/Button.js';
import { BoardView } from './BoardView.js';
import { NewBoardDialog } from './NewBoardDialog.js';
import { ServerUnreachable, StateScreen } from './StateScreen.js';

const SLOW_MS = 4000;

function useBoardSession(boardId: string, enabled: boolean): BoardSession | null {
  const [session, setSession] = useState<BoardSession | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const actor = currentActor();
    const next = createSession({
      boardId,
      actor,
      api,
      transport: (ydoc) => createWebsocketTransport(ydoc, boardId, actor),
    });
    setSession(next);
    rememberBoard(boardId);
    return () => {
      setSession(null);
      next.destroy();
    };
  }, [boardId, enabled]);
  return session;
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
  const session = useBoardSession(boardId, known);

  if (known && session) return <Connecting session={session} />;
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
