/**
 * Claims: "this agent is working on this node". They live in the document;
 * one that has passed its `until` no longer counts, even before the server
 * sweeps it away. `ClaimStore` keeps the claims in force and wakes up only at
 * the next expiry, and only while there are claims.
 */
import type { Actor, BoardDoc, Claim } from '@openboard/core';
import type { AgentSession } from '../lib/agents.js';
import { colorFor } from '../lib/identity.js';
import { type Clock, systemClock } from './activity.js';
import { Emitter } from './emitter.js';

/** Claims still in force at `now`, by node id. */
export function activeClaims(claims: readonly Claim[], now: number): Map<string, Claim> {
  const out = new Map<string, Claim>();
  for (const claim of claims) if (Date.parse(claim.until) > now) out.set(claim.nodeId, claim);
  return out;
}

/** When the next claim in force runs out, or null when none is. */
export function nextClaimExpiry(claims: readonly Claim[], now: number): number | null {
  let next = Number.POSITIVE_INFINITY;
  for (const claim of claims) {
    const until = Date.parse(claim.until);
    if (until > now) next = Math.min(next, until);
  }
  return Number.isFinite(next) ? next : null;
}

export interface ClaimChip {
  /** "Planner · working". */
  label: string;
  /** Who, why, and until when. */
  tooltip: string;
  color: string;
  name: string;
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** What a claimed card shows: the agent, what its session is doing, and the claim's details. */
export function claimChip(
  claim: Claim,
  actors: Readonly<Record<string, Actor>>,
  sessions: readonly AgentSession[],
  now: number,
): ClaimChip {
  const actor: Actor = actors[claim.by] ?? { id: claim.by, name: claim.by, kind: 'agent' };
  const session = sessions.find(
    (s) => s.actor.id === claim.by && (claim.session === undefined || s.session === claim.session),
  );
  const status = session && session.status !== 'idle' ? session.status : 'claimed';
  const until = Date.parse(claim.until);
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  const parts = [
    `${actor.name} is working on this.`,
    claim.note ? `Note: ${claim.note}` : '',
    `Claimed until ${clockTime(until)} (${minutes} min left).`,
  ].filter(Boolean);
  return {
    label: `${actor.name} · ${status}`,
    tooltip: parts.join(' '),
    color: colorFor({ ...actor, kind: 'agent' }),
    name: actor.name,
  };
}

export class ClaimStore extends Emitter {
  private active = new Map<string, Claim>();
  private timer: unknown = null;
  private readonly clock: Clock;
  private readonly doc: BoardDoc;
  private readonly detach: () => void;

  constructor(doc: BoardDoc, clock: Clock = systemClock) {
    super();
    this.doc = doc;
    this.clock = clock;
    this.refresh();
    this.detach = doc.observe((event) => {
      if (event.claims) this.refresh();
    });
  }

  readonly get = (): ReadonlyMap<string, Claim> => this.active;

  claimOn(nodeId: string): Claim | undefined {
    return this.active.get(nodeId);
  }

  destroy(): void {
    this.detach();
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private refresh(): void {
    const all = this.doc.claims();
    const now = this.clock.now();
    const next = activeClaims(all, now);
    const same =
      next.size === this.active.size &&
      [...next].every(([id, claim]) => this.active.get(id) === claim);
    if (!same) {
      this.active = next;
      this.emit();
    }
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    const at = nextClaimExpiry(all, now);
    if (at !== null)
      this.timer = this.clock.setTimeout(
        () => {
          this.timer = null;
          this.refresh();
        },
        at - now + 1,
      );
  }
}
