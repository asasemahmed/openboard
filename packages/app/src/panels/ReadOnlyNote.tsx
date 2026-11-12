/** Why the inspector's fields are off for this person, said once at the top. */
import type { AccessAction } from '@openboard/core';
import { disabledReason } from '../lib/roles.js';
import { useRole } from '../state/access.js';
import { Icon } from '../ui/Icon.js';

export function ReadOnlyNote({ action = 'board.edit' }: { action?: AccessAction }) {
  const role = useRole();
  return (
    <p className="readonly-note" role="note">
      <Icon name="eye" size={14} />
      {disabledReason(role, action)}
    </p>
  );
}
