/**
 * The share dialog as a reducer. An invite's token is in the state only
 * while the dialog is open: closing it (or starting another invite) drops it,
 * and it is never stored anywhere else.
 */
import type { AccessGrant, GrantAccessResult } from '@openboard/core';

export type GrantStatus = 'active' | 'expired' | 'revoked';

export function grantStatus(grant: AccessGrant, now: number): GrantStatus {
  if (grant.revokedAt) return 'revoked';
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= now) return 'expired';
  return 'active';
}

export interface Revealed {
  kind: 'human' | 'agent';
  grant: AccessGrant;
  /** The link for a person, or the token for an agent. Shown once. */
  secret: string;
}

export interface ShareState {
  grants: AccessGrant[] | null;
  error: string | null;
  busy: 'human' | 'agent' | null;
  revealed: Revealed | null;
}

export type ShareEvent =
  | { type: 'loaded'; grants: AccessGrant[] }
  | { type: 'failed'; message: string }
  | { type: 'create'; kind: 'human' | 'agent' }
  | { type: 'created'; kind: 'human' | 'agent'; result: GrantAccessResult }
  | { type: 'revoked'; grant: AccessGrant }
  | { type: 'hide' }
  | { type: 'closed' };

export const INITIAL_SHARE: ShareState = { grants: null, error: null, busy: null, revealed: null };

export function shareReducer(state: ShareState, event: ShareEvent): ShareState {
  switch (event.type) {
    case 'loaded':
      return { ...state, grants: event.grants, error: null };
    case 'failed':
      return { ...state, busy: null, error: event.message };
    case 'create':
      // A new invite hides the one shown before.
      return { ...state, busy: event.kind, error: null, revealed: null };
    case 'created': {
      const secret =
        event.kind === 'human'
          ? (event.result.inviteUrl ?? event.result.token)
          : event.result.token;
      return {
        ...state,
        busy: null,
        grants: [
          event.result.grant,
          ...(state.grants ?? []).filter((g) => g.id !== event.result.grant.id),
        ],
        revealed: { kind: event.kind, grant: event.result.grant, secret },
      };
    }
    case 'revoked':
      return {
        ...state,
        grants: (state.grants ?? []).map((g) => (g.id === event.grant.id ? event.grant : g)),
        revealed: state.revealed?.grant.id === event.grant.id ? null : state.revealed,
      };
    case 'hide':
    case 'closed':
      return event.type === 'closed' ? INITIAL_SHARE : { ...state, revealed: null };
  }
}

/** Active grants first (newest first), then the rest. */
export function sortedGrants(
  grants: readonly AccessGrant[],
  now: number,
): {
  active: AccessGrant[];
  ended: AccessGrant[];
} {
  const newest = (a: AccessGrant, b: AccessGrant) => b.createdAt.localeCompare(a.createdAt);
  return {
    active: grants.filter((g) => grantStatus(g, now) === 'active').sort(newest),
    ended: grants.filter((g) => grantStatus(g, now) !== 'active').sort(newest),
  };
}

export const EXPIRY_CHOICES: ReadonlyArray<{ label: string; hours: number | null }> = [
  { label: 'Never', hours: null },
  { label: 'In 1 day', hours: 24 },
  { label: 'In 7 days', hours: 24 * 7 },
  { label: 'In 30 days', hours: 24 * 30 },
];
