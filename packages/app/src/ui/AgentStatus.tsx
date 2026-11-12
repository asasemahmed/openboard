/**
 * An agent's status as a small glyph with its word next to it or in its
 * accessible name, so it never relies on colour alone.
 */
import type { AgentStatus } from '@openboard/core';
import { Icon, type IconName } from './Icon.js';

const GLYPH: Record<AgentStatus, IconName> = {
  reading: 'eye',
  writing: 'edit',
  working: 'settings',
  waiting: 'hourglass',
  idle: 'idle',
};

export const STATUS_WORD: Record<AgentStatus, string> = {
  reading: 'Reading',
  writing: 'Writing',
  working: 'Working',
  waiting: 'Waiting',
  idle: 'Idle',
};

/** The glyph alone, for corners of avatars; it is labelled for screen readers. */
export function StatusGlyph({ status, size = 10 }: { status: AgentStatus; size?: number }) {
  return (
    <span className={`status-glyph agent-${status}`} role="img" aria-label={STATUS_WORD[status]}>
      <Icon name={GLYPH[status]} size={size} />
    </span>
  );
}

/** Glyph and word, for rows. */
export function StatusLabel({ status }: { status: AgentStatus }) {
  return (
    <span className={`status-label agent-${status}`}>
      <Icon name={GLYPH[status]} size={12} />
      {STATUS_WORD[status]}
    </span>
  );
}
