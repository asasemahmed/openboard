import { useRef, useState } from 'react';
import { useConnection, useSession } from '../state/context.js';
import { Button } from '../ui/Button.js';
import { Popover } from '../ui/Popover.js';

const LABEL = { connecting: 'Connecting', live: 'Live', offline: 'Offline' } as const;

/** Connecting / Live / Offline. The shape of the mark differs per state, not only its colour. */
export function ConnectionStatus() {
  const session = useSession();
  const { status } = useConnection();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`conn conn-${status}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={
          status === 'offline'
            ? 'Offline: your edits are kept and sync when the server is back'
            : undefined
        }
      >
        <span className="conn-mark" aria-hidden="true" />
        {LABEL[status]}
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        label="Connection"
        align="end"
        className="conn-popover"
      >
        {status === 'live' && (
          <p>Connected. Changes from people and agents show up as they happen.</p>
        )}
        {status === 'connecting' && <p>Connecting to the OpenBoard server…</p>}
        {status === 'offline' && (
          <>
            <p>
              <strong>The server is not reachable.</strong> You can keep editing: your changes are
              kept in this tab and sync as soon as the server is back.
            </p>
            <p className="muted">Closing this tab before then discards them.</p>
            <Button size="sm" icon="refresh" onClick={() => session.connection.reconnect()}>
              Try again now
            </Button>
          </>
        )}
      </Popover>
    </>
  );
}
