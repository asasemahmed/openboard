import { useId, useRef, useState } from 'react';
import { IDENTITY_COLORS, NAME_MAX, toActor } from '../lib/identity.js';
import { updateIdentity, useIdentity } from '../state/identity.js';
import { Avatar } from '../ui/Avatar.js';
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
        <Avatar actor={toActor(me)} size={28} />
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
      </Popover>
    </>
  );
}
