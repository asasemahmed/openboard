/**
 * A two-route client router on the History API.
 *   /           the board list (or the last board on first load)
 *   /b/<id>     one board
 *   /?board=<id>  an older link form, replaced by /b/<id> on load
 */
import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'board'; boardId: string; cardId?: string }
  | { name: 'join' };

function decodeHash(hash: string): string | undefined {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw) || undefined;
  } catch {
    return undefined;
  }
}

export function parseRoute(pathname: string, hash = ''): Route {
  if (pathname.replace(/\/+$/, '') === '/join') return { name: 'join' };
  const match = /^\/b\/([^/]+)\/?$/.exec(pathname);
  if (match?.[1]) {
    try {
      const cardId = decodeHash(hash);
      return {
        name: 'board',
        boardId: decodeURIComponent(match[1]),
        ...(cardId ? { cardId } : {}),
      };
    } catch {
      return { name: 'home' };
    }
  }
  return { name: 'home' };
}

export function boardPath(boardId: string, cardId?: string): string {
  const base = `/b/${encodeURIComponent(boardId)}`;
  return cardId ? `${base}#${encodeURIComponent(cardId)}` : base;
}

export function cardUrl(boardId: string, cardId: string): string {
  const path = boardPath(boardId, cardId);
  return typeof location === 'undefined' ? path : new URL(path, location.origin).toString();
}

/** The `/b/<id>` path for an old `/?board=<id>` link, or null. */
export function legacyBoardRedirect(pathname: string, search: string): string | null {
  if (pathname !== '/' && pathname !== '') return null;
  const id = new URLSearchParams(search).get('board');
  return id ? boardPath(id) : null;
}

if (typeof location !== 'undefined' && typeof history !== 'undefined') {
  const target = legacyBoardRedirect(location.pathname, location.search);
  if (target) history.replaceState(null, '', target + location.hash);
}

const listeners = new Set<() => void>();
let current = typeof location === 'undefined' ? '/' : location.pathname + location.hash;
let cachedRoute: Route =
  typeof location === 'undefined' ? parseRoute('/') : parseRoute(location.pathname, location.hash);

function refresh(): void {
  const next = location.pathname + location.hash;
  if (next === current) return;
  current = next;
  cachedRoute = parseRoute(location.pathname, location.hash);
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', refresh);
  window.addEventListener('hashchange', refresh);
}

export function navigate(path: string, opts?: { replace?: boolean }): void {
  if (path === location.pathname + location.hash) return;
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
