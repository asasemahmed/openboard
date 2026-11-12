/**
 * Read an invite token from `/join#<token>` before anything else runs, and
 * wipe it from the address bar at once. Imported first by main.tsx. A link
 * opened while the app is already on `/join` only changes the fragment, so
 * the same happens on every `hashchange` there.
 */
import { takeJoinToken } from './lib/join.js';
import { Value } from './state/emitter.js';

/** The token from the invite link, if any is waiting; `attempt` grows with each new link. */
export const joinLink = new Value<{ token: string | null; attempt: number }>({
  token: null,
  attempt: 0,
});

function take(): void {
  const token = takeJoinToken(location, (url) => history.replaceState(null, '', url));
  if (token === null) return;
  joinLink.set({ token, attempt: joinLink.get().attempt + 1 });
}

if (typeof location !== 'undefined') {
  take();
  window.addEventListener('hashchange', take);
}

/** The token waiting to be used, or null. */
export function joinToken(): string | null {
  return joinLink.get().token;
}

/** Drop the token once the sign-in it was for is over, either way. */
export function forgetJoinToken(): void {
  const current = joinLink.get();
  if (current.token !== null) joinLink.set({ token: null, attempt: current.attempt });
}
