import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';

const CLASS = { update: ' is-change-proposed', remove: ' is-removal-proposed', conflict: '' };

/** A class for a node that a pending proposal would change or remove (empty otherwise). */
export function useReviewClass(id: string, ghost: boolean): string {
  const { store } = useSession();
  return useStoreValue(store, () => {
    if (ghost) return '';
    const kind = store.review().nodeMarks.get(id)?.kind;
    return kind ? CLASS[kind] : '';
  });
}

/** In a compare view: removed ghosts are drawn as removed; with "only changes", the rest dims. */
export function useDiffClass(id: string, ghost: boolean): string {
  const { ui } = useSession();
  const diff = useStoreValue(ui.diff, ui.diff.get);
  const only = useStoreValue(ui.onlyChanges, ui.onlyChanges.get);
  if (!diff) return '';
  let out = ghost && diff.removed.has(id) ? ' is-diff-removed' : '';
  if (only && !diff.touched.has(id)) out += ' is-unchanged';
  return out;
}
