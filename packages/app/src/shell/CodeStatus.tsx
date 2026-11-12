/**
 * "N nodes out of date with the code": a top-bar count of cards whose linked
 * code changed, live from the document, opening a list with the details the
 * server gives, and "Mark all as up to date".
 */
import type { LinkEntry } from '@openboard/core';
import { useReactFlow } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { reducedMotion } from '../canvas/actions.js';
import { plainLine } from '../lib/agents.js';
import { calmMessage } from '../lib/api.js';
import { outOfDate } from '../lib/codeLinks.js';
import { lineRange } from '../lib/editor.js';
import { useCan } from '../state/access.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { toasts } from '../state/toasts.js';
import { Button } from '../ui/Button.js';
import { Icon } from '../ui/Icon.js';
import { Popover } from '../ui/Popover.js';

export function CodeStatus() {
  const session = useSession();
  const { store, ui } = session;
  const count = useStoreValue(store, () => {
    let n = 0;
    for (const flow of store.nodes) if (!flow.data.ghost && outOfDate(flow.data.node) > 0) n++;
    return n;
  });
  const [open, setOpen] = useState(false);
  const canEdit = useCan('board.edit');
  const [entries, setEntries] = useState<LinkEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const flow = useReactFlow();

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    session.api
      .links(session.boardId, { stale: true })
      .then((result) => alive && setEntries(result.links))
      .catch((err: unknown) => alive && setError(calmMessage(err)));
    return () => {
      alive = false;
    };
  }, [open, session, count]);

  if (count === 0 && !open) return null;
  const label = `${count} node${count === 1 ? '' : 's'} out of date with the code`;
  const byNode = new Map<string, LinkEntry[]>();
  for (const e of entries ?? []) byNode.set(e.nodeId, [...(byNode.get(e.nodeId) ?? []), e]);

  const pan = (id: string) => {
    setOpen(false);
    store.select([id]);
    ui.pauseFollow();
    void flow.fitView({
      nodes: [{ id }],
      duration: reducedMotion() ? 0 : 260,
      padding: 0.5,
      maxZoom: 1.1,
    });
  };

  const refreshAll = () =>
    ui.confirm.set({
      title: 'Mark every link as up to date?',
      body: 'This accepts the code as it is now for every out-of-date link on the board: the links are checked against today’s code from here on. The cards themselves do not change, so read them first if the code change matters to them.',
      actions: [
        { label: 'Cancel', run: () => {} },
        {
          label: 'Mark all as up to date',
          tone: 'primary',
          run: () => {
            session.api
              .refreshLinks(session.boardId, { all: true })
              .then((result) =>
                toasts.show(
                  result.status === 'proposed'
                    ? 'Sent for review: someone has to accept the refreshed links.'
                    : 'Every link is up to date with the code now.',
                ),
              )
              .catch((err: unknown) => toasts.show(calmMessage(err), { tone: 'error' }));
          },
        },
      ],
    });

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="topbar-text-btn code-status"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(!open)}
      >
        <Icon name="code" />
        <span aria-hidden="true">{count}</span>
        <span className="topbar-label" aria-hidden="true">
          out of date
        </span>
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        align="end"
        label="Out of date with the code"
        className="code-popover"
      >
        <p className="code-popover-head">
          <strong>{label}</strong>
          <span className="muted small">
            The code they link to changed after they were written.
          </span>
        </p>
        {error && <p className="inline-error">{error}</p>}
        {entries === null && !error && (
          <p className="muted small">Asking the server what changed…</p>
        )}
        {entries !== null && byNode.size === 0 && (
          <p className="muted small">Everything is up to date.</p>
        )}
        <ul className="code-list">
          {[...byNode].map(([nodeId, list]) => (
            <li key={nodeId}>
              <button type="button" className="code-item" onClick={() => pan(nodeId)}>
                <strong>{plainLine(list[0]?.title, 60)}</strong>
                {list.map((e) => (
                  <span key={e.index} className="code-item-detail">
                    <code>
                      {plainLine(e.link.target, 50)}
                      {e.link.line ? `:${lineRange(e.link.line, e.link.endLine)}` : ''}
                    </code>{' '}
                    {plainLine(e.detail ?? e.state, 80)}
                  </span>
                ))}
              </button>
            </li>
          ))}
        </ul>
        {byNode.size > 0 && canEdit && (
          <Button size="sm" onClick={refreshAll}>
            Mark all as up to date…
          </Button>
        )}
      </Popover>
    </>
  );
}
