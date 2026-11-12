import { useId, useRef, useState } from 'react';
import { IDENTITY_COLORS, NAME_MAX, toActor } from '../lib/identity.js';
import { ROLE_TEXT } from '../lib/roles.js';
import { signedOut, useAccess } from '../state/access.js';
import { api } from '../state/boards.js';
import { updateIdentity, useIdentity } from '../state/identity.js';
import { Avatar } from '../ui/Avatar.js';
import { Button } from '../ui/Button.js';
import { Popover } from '../ui/Popover.js';

/** Your name and colour, as others see them on cursors and in the history. */
export function ProfileMenu() {
  const me = useIdentity();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(me.name);
  const anchor = useRef<HTMLButtonElement>(null);
  const nameId = useId();

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="profile-btn"
        aria-label={`Your profile: ${me.name}`}
        title="Your name and colour"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setName(me.name);
          setOpen(!open);
        }}
      >
        <Avatar actor={{ ...toActor(me), kind: 'human' }} size={28} />
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => {
          updateIdentity({ name });
          setOpen(false);
        }}
        label="Your profile"
        align="end"
        className="profile-popover"
      >
        <div className="field">
          <label className="field-label" htmlFor={nameId}>
            Your name
          </label>
          <input
            id={nameId}
            className="input"
            value={name}
            maxLength={NAME_MAX}
            data-autofocus
            onChange={(event) => setName(event.target.value)}
            onBlur={() => updateIdentity({ name })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                updateIdentity({ name });
                setOpen(false);
              }
            }}
          />
        </div>
        <fieldset className="field color-field">
          <legend className="field-label">Colour</legend>
          <div className="swatches">
            {IDENTITY_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`swatch${me.color === color ? ' is-active' : ''}`}
                style={{ background: color }}
                aria-label={`Colour ${color}`}
                aria-pressed={me.color === color}
                onClick={() => updateIdentity({ color })}
              />
            ))}
          </div>
        </fieldset>
        <p className="muted small">
          Shown on your cursor and next to your changes. Kept in this browser.
        </p>
        <SignedInAs />
      </Popover>
    </>
  );
}

/** In shared mode: who the server knows you as, your role, and signing out. */
function SignedInAs() {
  const state = useAccess();
  const [busy, setBusy] = useState(false);
  if (state.status !== 'ready' || state.who.via === 'local') return null;
  const { who } = state;
  const role = ROLE_TEXT[who.role];
  return (
    <div className="signed-in">
      <p>
        <strong>{role.name}</strong> access{' '}
        {who.expiresAt ? `until ${new Date(who.expiresAt).toLocaleDateString()}` : ''}
      </p>
      <p className="muted small">{role.you}</p>
      <Button
        size="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void api
            .signOut()
            .catch(() => {})
            .finally(() => signedOut('signed-out'));
        }}
      >
        Sign out
      </Button>
    </div>
  );
}
