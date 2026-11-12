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
