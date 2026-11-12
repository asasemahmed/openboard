/** The current person, shared by every screen. */
import type { Actor } from '@openboard/core';
import {
  cleanName,
  type Identity,
  loadIdentity,
  saveIdentity,
  toActor,
  withServerName,
} from '../lib/identity.js';
import { useValue, Value } from './emitter.js';

export const identity = new Value<Identity>(loadIdentity());

let actorCache: { identity: Identity; actor: Actor } | null = null;

/** The current actor. Same object until the identity changes. */
export function currentActor(): Actor {
  const current = identity.get();
  if (actorCache?.identity !== current) actorCache = { identity: current, actor: toActor(current) };
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
