/**
 * Joining from an invite link, `<server>/join#<token>`. The token lives in
 * the fragment, which never reaches the server or any log. It is read once,
 * the moment the app starts, and wiped from the address bar right away, so it
 * is not left in the history, a bookmark or a screenshot.
 */
import type { WhoAmI } from '@openboard/core';

export const JOIN_PATH = '/join';

/**
 * The invite token in a `/join` URL, after removing it from the address. Null
 * on any other page; an empty string on `/join` without one. Never redirects
 * anywhere based on the URL: the address becomes plain `/join`.
 */
export function takeJoinToken(
  loc: { pathname: string; hash: string },
  replace: (url: string) => void,
): string | null {
  if (loc.pathname.replace(/\/+$/, '') !== JOIN_PATH) return null;
  const raw = loc.hash.replace(/^#/, '');
  if (loc.hash) replace(JOIN_PATH);
  let token = raw;
  try {
    token = decodeURIComponent(raw);
  } catch {
    token = raw;
  }
  return token.trim();
}

export type JoinState =
  | { step: 'no-token' }
  | { step: 'joining' }
  | { step: 'joined'; who: WhoAmI }
  | { step: 'invalid'; message: string }
  | { step: 'rate-limited'; retryAfter: number | null }
  | { step: 'unreachable' }
  | { step: 'not-shared' };

export type JoinEvent =
  | { type: 'start' }
  | { type: 'joined'; who: WhoAmI }
  | { type: 'failed'; status: number; code: string; message: string; retryAfter: number | null };

export function initialJoin(token: string | null): JoinState {
  return token ? { step: 'joining' } : { step: 'no-token' };
}

export function joinReducer(state: JoinState, event: JoinEvent): JoinState {
  switch (event.type) {
    case 'start':
      return state.step === 'no-token' ? state : { step: 'joining' };
    case 'joined':
      return state.step === 'joining' ? { step: 'joined', who: event.who } : state;
    case 'failed': {
      if (state.step !== 'joining') return state;
      if (event.status === 429) return { step: 'rate-limited', retryAfter: event.retryAfter };
      if (event.code === 'unreachable') return { step: 'unreachable' };
      if (event.status === 400 && /not shared/.test(event.message)) return { step: 'not-shared' };
      return {
        step: 'invalid',
        message: event.message || 'This invite link is not valid: it is wrong, expired or revoked.',
      };
    }
  }
}
