import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A local draft of a document field. It follows the document while the
 * person is not editing, and keeps their text while they are (the last
 * writer wins once they commit).
 */
export function useDraft<T>(value: T, commit: (next: T) => void) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  const latest = useRef(value);
  const draftRef = useRef(draft);
  latest.current = value;
  draftRef.current = draft;

  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);

  const change = useCallback((next: T) => {
    dirty.current = true;
    draftRef.current = next;
    setDraft(next);
  }, []);

  const save = useCallback(
    (next?: T) => {
      const toSave = next === undefined ? draftRef.current : next;
      dirty.current = false;
      if (!Object.is(toSave, latest.current)) commit(toSave);
    },
    [commit],
  );

  const reset = useCallback(() => {
    dirty.current = false;
    setDraft(latest.current);
  }, []);

  return { draft, change, save, reset };
}
