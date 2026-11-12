import { STATUSES, type Status } from '@openboard/core';
import { useId } from 'react';
import { useActions } from '../canvas/actions.js';
import { STATUS_META, typeMeta } from '../lib/nodeTypes.js';
import type { Selection } from '../state/boardStore.js';
import { useSession } from '../state/context.js';
import { Button } from '../ui/Button.js';
import { Section } from './fields.js';

export function MultiInspector({ selection }: { selection: Selection }) {
  const { store } = useSession();
  const actions = useActions();
  const statusId = useId();
  const counts = new Map<string, number>();
  for (const id of selection.nodeIds) {
    const type = store.node(id)?.type;
    if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const statusable = selection.nodeIds.filter((id) => store.node(id)?.type !== 'frame');
  const total = selection.nodeIds.length + selection.edgeIds.length;

  return (
    <div className="inspector-multi">
      <Section>
        <p className="inspector-count">{total} selected</p>
        <ul className="type-counts">
          {[...counts].map(([type, count]) => {
            const meta = typeMeta(type);
            return (
              <li key={type} className={`tone-${meta.tone}`}>
                <span className="type-dot" aria-hidden="true" />
                {count} {meta.name.toLowerCase()}
                {count === 1 ? '' : 's'}
              </li>
            );
          })}
          {selection.edgeIds.length > 0 && (
            <li className="tone-custom">
              <span className="type-dot" aria-hidden="true" />
              {selection.edgeIds.length} connection{selection.edgeIds.length === 1 ? '' : 's'}
            </li>
          )}
        </ul>
      </Section>
      {statusable.length > 0 && (
        <Section title="Set status">
          <label htmlFor={statusId} className="visually-hidden">
            Status for {statusable.length} nodes
          </label>
          <select
            id={statusId}
            className="input"
            value=""
            onChange={(event) => {
              const value = event.target.value;
              if (value) actions.setStatus(statusable, value === 'none' ? null : (value as Status));
            }}
          >
            <option value="" disabled>
              Choose a status for {statusable.length}
            </option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_META[s].name}
              </option>
            ))}
            <option value="none">No status</option>
          </select>
        </Section>
      )}
      <Section>
        <div className="inspector-actions">
          {selection.nodeIds.length > 0 && (
            <>
              <Button size="sm" icon="frame" onClick={actions.frameSelection}>
                Frame
              </Button>
              <Button size="sm" icon="copy" onClick={actions.duplicateSelection}>
                Duplicate
              </Button>
            </>
          )}
          <Button size="sm" variant="danger" icon="trash" onClick={actions.deleteSelection}>
            Delete {total}
          </Button>
        </div>
      </Section>
    </div>
  );
}
