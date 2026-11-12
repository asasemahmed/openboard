import type { Actor } from '@openboard/core';
import { colorFor, initials } from '../lib/identity.js';

/** Initials on the actor's colour. Agents are drawn as rounded squares, people as circles. */
export function Avatar({ actor, size = 24 }: { actor: Actor; size?: number }) {
  return (
    <span
      className={`avatar avatar-${actor.kind}`}
      style={{ background: colorFor(actor), width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {initials(actor.name)}
    </span>
  );
}
