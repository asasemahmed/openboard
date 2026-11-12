/** Theme preference: follow the system, or force light or dark. Persisted. */
import { useSyncExternalStore } from 'react';
import { readStored, writeStored } from './storage.js';

export type ThemePref = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const KEY = 'theme';
const isPref = (value: unknown): value is ThemePref =>
  value === 'system' || value === 'light' || value === 'dark';

const listeners = new Set<() => void>();
let pref: ThemePref = readStored(KEY, isPref) ?? 'system';

function media(): MediaQueryList | null {
  return typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
}

function resolve(p: ThemePref): ResolvedTheme {
  if (p !== 'system') return p;
  return media()?.matches ? 'dark' : 'light';
}

let resolved: ResolvedTheme = resolve(pref);
let snapshot = { pref, resolved };

function emit(): void {
  resolved = resolve(pref);
  if (snapshot.pref !== pref || snapshot.resolved !== resolved) snapshot = { pref, resolved };
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (pref === 'system') delete root.dataset.theme;
    else root.dataset.theme = pref;
  }
  for (const listener of listeners) listener();
}

media()?.addEventListener?.('change', emit);

export function setThemePref(next: ThemePref): void {
  pref = next;
  writeStored(KEY, next);
  emit();
}

export const THEME_ORDER: ThemePref[] = ['system', 'light', 'dark'];

export function cycleTheme(): ThemePref {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(pref) + 1) % THEME_ORDER.length] ?? 'system';
  setThemePref(next);
  return next;
}

export function useTheme(): { pref: ThemePref; resolved: ResolvedTheme } {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}
