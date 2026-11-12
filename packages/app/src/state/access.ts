/**
 * Who this browser is to the server, and what it may do. On startup the app
 * asks `whoami` before anything else. In local mode that is the owner at this
 * machine, with the locally made identity as before; in shared mode a
 * signed-in person's actor comes from their access grant, and only the
 * display name stays theirs to set.
 *
 * `can(role, action)` from core is the only rule; components ask `useCan`.
 */
import { type AccessAction, type Actor, can, type Role, type WhoAmI } from '@openboard/core';
import { type ApiClient, ApiError } from '../lib/api.js';
import { useStoreValue, Value } from './emitter.js';

export type SignedOutReason = 'revoked' | 'unauthorized' | 'signed-out';

export type AccessState =
  | { status: 'loading' }
  | { status: 'ready'; who: WhoAmI }
  | { status: 'signed-out'; reason: SignedOutReason; message: string; lostEdits: boolean };

export const access = new Value<AccessState>({ status: 'loading' });

/** The owner at this machine, for servers too old to answer `whoami`. */
function localOwner(actor: Actor): WhoAmI {
  return { actor, role: 'owner', shared: false, via: 'local' };
}

/** Ask the server who we are. A 401 is handled by the API client's sign-out hook. */
export async function loadAccess(api: ApiClient, actor: () => Actor): Promise<void> {
  try {
    access.set({ status: 'ready', who: await api.whoami() });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      signedOut('unauthorized', error.message);
      return;
    }
    // An older server has no `whoami`, and an unreachable one is shown by the board list:
    // either way this is the local owner, exactly as before.
    access.set({ status: 'ready', who: localOwner(actor()) });
  }
}

/** Show the signed-out page. A later reason never hides earlier lost edits. */
export function signedOut(reason: SignedOutReason, message = '', lostEdits = false): void {
  const current = access.get();
  const lost = lostEdits || (current.status === 'signed-out' && current.lostEdits);
  access.set({ status: 'signed-out', reason, message, lostEdits: lost });
}

export function setWho(who: WhoAmI): void {
  access.set({ status: 'ready', who });
}

/** The role in force: the owner until the server has said otherwise; nothing while signed out. */
export function roleOf(state: AccessState): Role {
  if (state.status === 'ready') return state.who.role;
  return state.status === 'loading' ? 'owner' : 'viewer';
}

/** Signed in with a grant (an invite) rather than trusted as the owner at this machine. */
export function isRemote(state: AccessState): boolean {
  return state.status === 'ready' && state.who.via !== 'local';
}

export function canNow(action: AccessAction): boolean {
  return can(roleOf(access.get()), action);
}

export function useAccess(): AccessState {
  return useStoreValue(access, access.get);
}

export function useRole(): Role {
  return useStoreValue(access, () => roleOf(access.get()));
}

/** Whether this person may attempt `action`. The one check every control uses. */
export function useCan(action: AccessAction): boolean {
  return useStoreValue(access, () => can(roleOf(access.get()), action));
}

/**
 * Whether this person's document writes reach the board. Viewers and
 * commenters get a read-only sync connection: the server drops their
 * updates, so anything they do goes through the API instead.
 */
export function writesThroughSync(role: Role): boolean {
  return can(role, 'board.edit');
}
