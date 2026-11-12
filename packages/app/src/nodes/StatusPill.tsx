import type { Status } from '@openboard/core';
import { STATUS_META } from '../lib/nodeTypes.js';
import { Icon, type IconName } from '../ui/Icon.js';

const ICONS: Record<Status, IconName> = {
  todo: 'statusTodo',
  in_progress: 'statusProgress',
  blocked: 'statusBlocked',
  done: 'statusDone',
  cancelled: 'statusCancelled',
};

/** Status as shape + word + colour, so colour is never the only signal. */
export function StatusPill({ status, size = 'sm' }: { status: Status; size?: 'sm' | 'md' }) {
  const meta = STATUS_META[status];
  return (
    <span className={`status-pill status-${meta.tone} status-pill-${size}`}>
      <Icon name={ICONS[status]} size={size === 'sm' ? 12 : 14} />
      {meta.name}
    </span>
  );
}

export function StatusIcon({ status }: { status: Status }) {
  return (
    <span className={`status-icon status-${STATUS_META[status].tone}`}>
      <Icon name={ICONS[status]} size={14} />
    </span>
  );
}
