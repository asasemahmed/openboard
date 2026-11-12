import { Button, Kbd } from '../ui/Button.js';
import type { BoardActions } from './actions.js';

/** Shown over an empty canvas. The canvas stays live underneath (double-click still works). */
export function EmptyBoard({ actions }: { actions: BoardActions }) {
  return (
    <div className="empty-board" role="note">
      <div className="empty-board-card">
        <h2>This board is empty</h2>
        <p>
          Double-click anywhere or press <Kbd shortcut="n" /> to add a note.
        </p>
        <p className="muted">Agents connected over MCP can fill it in too.</p>
        <div className="empty-board-actions">
          <Button
            variant="primary"
            icon="plus"
            onClick={() => actions.addNode('note', actions.viewCenter())}
          >
            Add a note
          </Button>
          <Button icon="plus" onClick={() => actions.addNode('task', actions.viewCenter())}>
            Add a task
          </Button>
        </div>
      </div>
    </div>
  );
}
