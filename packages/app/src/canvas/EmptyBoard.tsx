import { useEffect, useState } from 'react';
import { calmMessage } from '../lib/api.js';
import { starters, templateIcon } from '../lib/templateFlow.js';
import { useSession } from '../state/context.js';
import { loadTemplates, useTemplateList } from '../state/templates.js';
import { toasts } from '../state/toasts.js';
import { Button, Kbd } from '../ui/Button.js';
import { TypeIcon } from '../ui/TypeIcon.js';
import type { BoardActions } from './actions.js';

/** Shown over an empty canvas. The canvas stays live underneath (double-click still works). */
export function EmptyBoard({ actions }: { actions: BoardActions }) {
  const session = useSession();
  const { ui } = session;
  const templates = useTemplateList();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    loadTemplates().catch(() => {});
  }, []);

  const start = async (id: string, name: string) => {
    setBusy(id);
    try {
      const result = await session.api.applyTemplate(session.boardId, { template: id });
      if (result.status === 'invalid')
        toasts.show(result.errors?.[0]?.message ?? `“${name}” could not be inserted.`, {
          tone: 'error',
        });
      else if (result.status === 'proposed')
        toasts.show(`“${name}” waits for someone to accept it in Review.`);
      else void actions.reveal(result.applied?.addedNodes ?? []);
    } catch (error) {
      toasts.show(calmMessage(error), { tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const offered = templates ? starters(templates) : [];

  return (
    <div className="empty-board" role="note">
      <div className="empty-board-card">
        <h2>This board is empty</h2>
        <p>
          Double-click anywhere or press <Kbd shortcut="n" /> to add a note.
        </p>
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
        {offered.length > 0 && (
          <div className="empty-board-templates">
            <h3 className="field-label">Or start from a template</h3>
            <ul>
              {offered.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="starter"
                    disabled={busy !== null}
                    title={t.description}
                    onClick={() => void start(t.id, t.name)}
                  >
                    <span className="template-icon" aria-hidden="true">
                      <TypeIcon name={templateIcon(t.id)} />
                    </span>
                    <span>{busy === t.id ? 'Inserting…' : t.name}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="link-btn"
              onClick={() => ui.templateDialog.set({ frame: null })}
            >
              More templates…
            </button>
          </div>
        )}
        <p className="muted">
          Agents connected over MCP can fill it in too.{' '}
          <button type="button" className="link-btn" onClick={() => ui.connectAgent.set(true)}>
            Connect an agent
          </button>
        </p>
      </div>
    </div>
  );
}
