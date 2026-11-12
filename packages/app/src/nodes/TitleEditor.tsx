import { LIMITS } from '@openboard/core';
import { useEffect, useRef, useState } from 'react';
import { focusNodeElement } from '../canvas/nodeFocus.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';

export function useIsEditing(id: string): boolean {
  const { ui } = useSession();
  return useStoreValue(ui.editing, () => ui.editing.get() === id);
}

/**
 * Inline title editor. Enter or blur saves, Escape cancels. An empty title
 * is not allowed, so clearing it and leaving keeps the old one.
 */
export function TitleEditor({
  id,
  title,
  lines,
  className,
}: {
  id: string;
  title: string;
  lines: number;
  className?: string;
}) {
  const session = useSession();
  const [value, setValue] = useState(title);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  /** `refocus`: the person finished with the keyboard, so focus goes back to the node. */
  const finish = (save: boolean, refocus: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = value.replace(/\s+/g, ' ').trim().slice(0, LIMITS.title);
    if (save && next && next !== title) {
      const outcome = session.store.apply(
        [{ op: 'update_node', id, patch: { title: next } }],
        session.actor(),
      );
      if (!outcome.ok) done.current = false;
    }
    if (session.ui.editing.get() === id) session.ui.editing.set(null);
    // Hand focus back to the node so keyboard shortcuts and navigation keep working.
    // After a blur, focus already went where the person clicked; leave it there.
    if (refocus) focusNodeElement(id);
  };

  return (
    <textarea
      ref={ref}
      className={`title-editor nodrag nopan nowheel ${className ?? ''}`}
      aria-label="Title"
      value={value}
      rows={lines}
      maxLength={LIMITS.title}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true, false)}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          finish(true, true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false, true);
        }
      }}
    />
  );
}
