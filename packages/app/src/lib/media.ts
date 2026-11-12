/** Whether a media query matches, kept up to date. */
import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof matchMedia !== 'function') return () => {};
      const list = matchMedia(query);
      list.addEventListener?.('change', onChange);
      return () => list.removeEventListener?.('change', onChange);
    },
    () => typeof matchMedia === 'function' && matchMedia(query).matches,
    () => false,
  );
}

/** Below these widths the top bar folds its secondary actions into the overflow menu. */
export const TOPBAR_FOLD = '(max-width: 1480px)';
export const TOPBAR_NARROW = '(max-width: 1100px)';
