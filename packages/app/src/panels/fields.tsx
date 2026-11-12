import type { Actor } from '@openboard/core';
import { type ReactNode, useId } from 'react';
import { absoluteTime, relativeTime } from '../lib/time.js';
import { useMeta } from '../state/context.js';
import { toasts } from '../state/toasts.js';
import { Icon } from '../ui/Icon.js';

export function Section({
  title,
  children,
  aside,
}: {
  title?: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="inspector-section">
      {title && (
        <div className="inspector-section-head">
          <h3>{title}</h3>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/** A labelled control. `children` receives the id to put on the control. */
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: (id: string) => ReactNode;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {children(id)}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export async function copyText(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toasts.show(`${what}: ${text}`);
  } catch {
    toasts.show('Copying is blocked in this browser. Select the text and copy it instead.', {
      tone: 'error',
    });
  }
}

/** The id agents and people use to refer to a node or edge, with a copy button. */
export function IdRow({ id, kind }: { id: string; kind: 'node' | 'edge' }) {
  return (
    <div className="id-row">
      <code className="id-code" title={`${kind === 'node' ? 'Node' : 'Edge'} id`}>
        {id}
      </code>
      <button
        type="button"
        className="icon-btn icon-btn-sm"
        aria-label={`Copy ${kind} id`}
        title={`Copy ${kind} id`}
        onClick={() => void copyText(id, 'Copied id')}
      >
        <Icon name="copy" />
      </button>
    </div>
  );
}

function actorName(actors: Readonly<Record<string, Actor>>, id: string): string {
  const actor = actors[id];
  if (!actor) return id === 'system' ? 'OpenBoard' : id;
  return actor.kind === 'agent' ? `${actor.name} (agent)` : actor.name;
}

/** "Created by Ada, 3 h ago · Updated by planner (agent), just now". */
export function Provenance({
  createdBy,
  createdAt,
  updatedBy,
  updatedAt,
}: {
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}) {
  const { actors } = useMeta();
  const same = createdAt === updatedAt && createdBy === updatedBy;
  return (
    <p className="provenance">
      Created by <strong>{actorName(actors, createdBy)}</strong>{' '}
      <time dateTime={createdAt} title={absoluteTime(createdAt)}>
        {relativeTime(createdAt)}
      </time>
      {!same && (
        <>
          <br />
          Updated by <strong>{actorName(actors, updatedBy)}</strong>{' '}
          <time dateTime={updatedAt} title={absoluteTime(updatedAt)}>
            {relativeTime(updatedAt)}
          </time>
        </>
      )}
    </p>
  );
}
