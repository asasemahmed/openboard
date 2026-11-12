/** The current person, shared by every screen. */
import type { Actor, WhoAmI } from '@openboard/core';
import {
  cleanName,
  type Identity,
  loadIdentity,
  saveIdentity,
  toActor,
  withServerName,
} from '../lib/identity.js';
import { access } from './access.js';
import { useValue, Value } from './emitter.js';

export const identity = new Value<Identity>(loadIdentity());

let actorCache: { identity: Identity; who: WhoAmI | null; actor: Actor } | null = null;

/**
 * The actor this browser acts as, given what the server said. Signed in with
 * a grant, the id and kind are the grant's (a locally made id would be
 * meaningless, and the server ignores it); the display name is still the
 * person's own. Otherwise, the local identity, as it always was.
 */
export function actorFor(local: Identity, who: WhoAmI | null): Actor {
  const mine = toActor(local);
  if (!who || who.via === 'local') return mine;
  return { ...mine, id: who.actor.id, kind: who.actor.kind };
}

/** The current actor. Same object until the identity or the sign-in changes. */
export function currentActor(): Actor {
  const current = identity.get();
  const state = access.get();
  const who = state.status === 'ready' ? state.who : null;
  if (actorCache?.identity !== current || actorCache.who !== who)
    actorCache = { identity: current, who, actor: actorFor(current, who) };
  return actorCache.actor;
}

export function updateIdentity(patch: Partial<Pick<Identity, 'name' | 'color'>>): void {
  const current = identity.get();
  const next: Identity = {
    ...current,
    ...(patch.name !== undefined ? { name: cleanName(patch.name) } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
  };
  if (patch.name !== undefined && next.name !== current.name) next.named = true;
  if (next.name === current.name && next.color === current.color) return;
  saveIdentity(next);
  identity.set(next);
}

export function useIdentity(): Identity {
  return useValue(identity);
}

/** Use the server's name for the person (`GET /api/info` `user`) until they choose their own. */
export function adoptServerName(user: string | undefined): void {
  const current = identity.get();
  const next = withServerName(current, user);
  if (next === current) return;
  saveIdentity(next);
  identity.set(next);
}
