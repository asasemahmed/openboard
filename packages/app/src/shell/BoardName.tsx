import { useState } from 'react';
import { useMeta, useSession } from '../state/context.js';
import { toasts } from '../state/toasts.js';

/** The board's name; click to rename. */
export function BoardName() {
  const session = useSession();
  const { meta } = useMeta();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(meta.name);

  const commit = () => {
    setEditing(false);
    const name = value.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name || name === meta.name) return;
    try {
      session.doc.setMeta({ name }, session.actor(), { source: 'ui' });
    } catch (error) {
      toasts.show(error instanceof Error ? error.message : 'Could not rename the board.', {
        tone: 'error',
      });
    }
  };

  if (editing) {
    return (
      <input
        className="board-name-input"
        aria-label="Board name"
        value={value}
        maxLength={120}
        autoFocus
        onFocus={(event) => event.target.select()}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className="board-name"
      title="Rename board"
      onClick={() => {
        setValue(meta.name);
        setEditing(true);
      }}
    >
      {meta.name}
    </button>
  );
}
