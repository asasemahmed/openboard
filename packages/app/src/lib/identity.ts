/**
 * The person using this browser. Generated once, kept in localStorage, and
 * sent with every request and over the presence channel.
 */
import { type Actor, newId } from '@openboard/core';
import { readStored, writeStored } from './storage.js';

export interface Identity {
  id: string;
  name: string;
  color: string;
}

/** Cursor and avatar colours. Each keeps white text above 4.5:1. */
export const IDENTITY_COLORS = [
  '#C2410C',
  '#0B7A55',
  '#1D5FBF',
  '#7A3FC4',
  '#B42357',
  '#8A6100',
  '#0F6F8A',
  '#4D5560',
] as const;

const KEY = 'identity';
export const DEFAULT_NAME = 'Guest';
export const NAME_MAX = 80;

function isIdentity(value: unknown): value is Identity {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    /^a_[a-z0-9]{4,}$/.test(v.id) &&
    typeof v.name === 'string' &&
    v.name.trim().length > 0 &&
    typeof v.color === 'string'
  );
}

export function loadIdentity(): Identity {
  const stored = readStored(KEY, isIdentity);
  if (stored) return { ...stored, name: cleanName(stored.name) };
  const fresh: Identity = {
    id: newId('a'),
    name: DEFAULT_NAME,
    color: IDENTITY_COLORS[Math.floor(Math.random() * IDENTITY_COLORS.length)] ?? '#C2410C',
  };
  writeStored(KEY, fresh);
  return fresh;
}

export function saveIdentity(identity: Identity): void {
  writeStored(KEY, identity);
}

export function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
  return trimmed || DEFAULT_NAME;
}

export function toActor(identity: Identity): Actor {
  return { id: identity.id, kind: 'human', name: identity.name, color: identity.color };
}

/** A stable colour for an actor that did not choose one. */
export function colorFor(actor: Pick<Actor, 'id' | 'color' | 'kind'>): string {
  if (actor.color) return actor.color;
  if (actor.kind === 'agent') return '#C2410C';
  let hash = 0;
  for (let i = 0; i < actor.id.length; i++) hash = (hash * 31 + actor.id.charCodeAt(i)) | 0;
  return IDENTITY_COLORS[Math.abs(hash) % IDENTITY_COLORS.length] ?? '#4D5560';
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 1).toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase();
}
