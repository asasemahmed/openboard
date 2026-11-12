/** The board list. On first load it reopens the last board you had open. */
import { useEffect, useState } from 'react';
import { boardPath, navigate } from '../lib/router.js';
import { relativeTime } from '../lib/time.js';
import { boards, lastBoardId, useBoards } from '../state/boards.js';
import { Button } from '../ui/Button.js';
import { Logo } from '../ui/Icon.js';
import { Toasts } from '../ui/Toasts.js';
import { NewBoardDialog, NewBoardForm } from './NewBoardDialog.js';
import { ProfileMenu } from './ProfileMenu.js';
import { ServerUnreachable, StateScreen } from './StateScreen.js';
import { ThemeToggle } from './ThemeToggle.js';

export function HomeScreen({ resumeLast }: { resumeLast: boolean }) {
  const list = useBoards();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void boards.refresh();
  }, []);

  useEffect(() => {
    if (!resumeLast || list.status !== 'ready') return;
    const last = lastBoardId();
    if (last && list.boards.some((b) => b.id === last))
      navigate(boardPath(last), { replace: true });
  }, [resumeLast, list]);

  if (list.status === 'error' && list.error.unreachable) {
    return <ServerUnreachable onRetry={() => void boards.refresh()} />;
  }
  if (list.status === 'loading' && list.boards.length === 0)
    return <StateScreen title="Loading boards…" busy />;
  if (list.status === 'ready' && list.boards.length === 0) {
    return (
      <StateScreen title="Create your first board">
        <p>
          A board is a shared canvas for you and your agents. Start with a name; you can change it
          later.
        </p>
        <NewBoardForm />
      </StateScreen>
    );
  }

  return (
    <div className="home">
      <header className="home-head">
        <div className="home-brand">
          <Logo size={28} />
          <span className="wordmark">
            Open<span>Board</span>
          </span>
        </div>
        <div className="home-head-end">
          <ThemeToggle />
          <ProfileMenu />
        </div>
      </header>
      <main className="home-main">
        <div className="home-title-row">
          <h1>Boards</h1>
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            New board
          </Button>
        </div>
        {list.status === 'error' && (
          <p className="field-error" role="alert">
            Could not refresh the list: {list.error.message}
          </p>
        )}
        <ul className="board-grid">
          {list.boards.map((board) => (
            <li key={board.id}>
              <a
                className="board-card"
                href={boardPath(board.id)}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                  event.preventDefault();
                  navigate(boardPath(board.id));
                }}
              >
                <span className="board-card-name">{board.name}</span>
                {board.description && <span className="board-card-desc">{board.description}</span>}
                <span className="board-card-meta">
                  {board.nodeCount} node{board.nodeCount === 1 ? '' : 's'}, {board.edgeCount}{' '}
                  connection
                  {board.edgeCount === 1 ? '' : 's'}, updated {relativeTime(board.updatedAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </main>
      <NewBoardDialog open={creating} onClose={() => setCreating(false)} />
      <Toasts />
    </div>
  );
}
