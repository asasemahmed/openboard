/**
 * A two-route client router on the History API.
 *   /           the board list (or the last board on first load)
 *   /b/<id>     one board
 */
import { useSyncExternalStore } from 'react';

export type Route = { name: 'home' } | { name: 'board'; boardId: string };

export function parseRoute(pathname: string): Route {
  const match = /^\/b\/([^/]+)\/?$/.exec(pathname);
  if (match?.[1]) {
    try {
      return { name: 'board', boardId: decodeURIComponent(match[1]) };
    } catch {
      return { name: 'home' };
    }
  }
  return { name: 'home' };
}

export function boardPath(boardId: string): string {
  return `/b/${encodeURIComponent(boardId)}`;
}

const listeners = new Set<() => void>();
let current = typeof location === 'undefined' ? '/' : location.pathname;
let cachedRoute: Route = parseRoute(current);

function refresh(): void {
  const next = location.pathname;
  if (next === current) return;
  current = next;
  cachedRoute = parseRoute(next);
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') window.addEventListener('popstate', refresh);

export function navigate(path: string, opts?: { replace?: boolean }): void {
  if (path === location.pathname) return;
  if (opts?.replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  refresh();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRoute(): Route {
  return useSyncExternalStore(
    subscribe,
    () => cachedRoute,
    () => cachedRoute,
  );
}
