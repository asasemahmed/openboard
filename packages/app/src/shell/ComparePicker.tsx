/** "Compare with…": pick a git revision of this board's file. */
import type { RevisionsResult } from '@openboard/core';
import { useEffect, useState } from 'react';
import { plainLine } from '../lib/agents.js';
import { calmMessage } from '../lib/api.js';
import { compareTarget, revisionPicker } from '../lib/revisions.js';
import { absoluteTime, relativeTime } from '../lib/time.js';
import { useSession } from '../state/context.js';
import { useValue } from '../state/emitter.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; result: RevisionsResult };

export function ComparePicker() {
  const session = useSession();
  const { ui } = session;
  const open = useValue(ui.comparePicker);
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoad({ status: 'loading' });
    session.api
      .revisions(session.boardId, 50)
      .then((result) => alive && setLoad({ status: 'ready', result }))
      .catch(
        (error: unknown) => alive && setLoad({ status: 'error', message: calmMessage(error) }),
      );
    return () => {
      alive = false;
    };
  }, [open, session]);

  const close = () => ui.comparePicker.set(false);
  const picker = load.status === 'ready' ? revisionPicker(load.result) : null;

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Compare with a revision"
      size="md"
      description="See what changed on this board since a commit of its file."
    >
      <div className="revision-picker">
        {load.status === 'loading' && (
          <p className="muted small">Reading the history of the board file…</p>
        )}
        {load.status === 'error' && <p className="inline-error">{load.message}</p>}
        {picker?.state === 'untracked' && (
          <p className="muted">
            This board is not in git yet. Commit the <code>.openboard/</code> folder with your code,
            and every commit becomes something to compare with.
          </p>
        )}
        {picker?.state === 'empty' && (
          <p className="muted">
            The board file has no commits yet. Commit it to compare with it later.
          </p>
        )}
        {picker?.state === 'list' && (
          <>
            {picker.dirty && (
              <p className="revision-dirty">
                <span className="badge badge-proposal">Uncommitted changes</span> The board has
                changed since its last commit.
              </p>
            )}
            <ul className="revision-list">
              {picker.revisions.map((revision, i) => (
                <li key={revision.rev}>
                  <button
                    type="button"
                    className="revision-row"
                    data-autofocus={i === 0 ? true : undefined}
                    onClick={() => {
                      close();
                      ui.compare.set(compareTarget(revision));
                    }}
                  >
                    <code className="revision-hash">{revision.short}</code>
                    <span className="revision-subject">{plainLine(revision.subject, 90)}</span>
                    <span className="revision-meta">
                      {plainLine(revision.author, 40)},{' '}
                      <time dateTime={revision.at} title={absoluteTime(revision.at)}>
                        {relativeTime(revision.at)}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="dialog-actions">
        <Button onClick={close}>Cancel</Button>
      </div>
    </Dialog>
  );
}
