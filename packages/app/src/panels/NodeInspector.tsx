import { type BoardNode, LIMITS, type NodePatch, STATUSES, type Status } from '@openboard/core';
import { useCallback } from 'react';
import { applyOrReport, useActions } from '../canvas/actions.js';
import { CARD_TYPES, STATUS_META, typeMeta } from '../lib/nodeTypes.js';
import { useSession } from '../state/context.js';
import { Button } from '../ui/Button.js';
import { BodyEditor } from './BodyEditor.js';
import { ClaimSection } from './ClaimSection.js';
import { FrameAccessField } from './FrameAccessField.js';
import { Field, IdRow, Provenance, Section } from './fields.js';
import { LinksEditor } from './LinksEditor.js';
import { TagsEditor } from './TagsEditor.js';
import { NodeComments } from './Threads.js';
import { useDraft } from './useDraft.js';

export function NodeInspector({ node }: { node: BoardNode }) {
  const session = useSession();
  const actions = useActions();
  const meta = typeMeta(node.type);
  const isFrame = node.type === 'frame';

  const patch = useCallback(
    (p: NodePatch) => applyOrReport(session, [{ op: 'update_node', id: node.id, patch: p }]),
    [session, node.id],
  );

  const title = useDraft(node.title, (next) => {
    const clean = next.replace(/\s+/g, ' ').trim();
    if (clean) patch({ title: clean });
    else title.reset();
  });

  const typeOptions: string[] = CARD_TYPES.includes(node.type as (typeof CARD_TYPES)[number])
    ? [...CARD_TYPES]
    : [node.type, ...CARD_TYPES];
  const props = Object.entries(node.props ?? {});

  return (
    <div className="inspector-node">
      <ClaimSection nodeId={node.id} />
      <Section>
        <div className={`inspector-type tone-${meta.tone}`}>
          <span className="type-dot" aria-hidden="true" />
          {isFrame ? (
            <span className="type-label">frame</span>
          ) : (
            <>
              <label htmlFor={`type-${node.id}`} className="visually-hidden">
                Type
              </label>
              <select
                id={`type-${node.id}`}
                className="type-select"
                value={node.type}
                onChange={(event) => patch({ type: event.target.value })}
              >
                {typeOptions.map((type) => (
                  <option key={type} value={type}>
                    {typeMeta(type).name}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        <Field label="Title">
          {(id) => (
            <textarea
              id={id}
              className="input title-input"
              rows={2}
              maxLength={LIMITS.title}
              value={title.draft}
              onChange={(event) => title.change(event.target.value)}
              onBlur={() => title.save()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  title.save();
                  (event.target as HTMLTextAreaElement).blur();
                } else if (event.key === 'Escape') {
                  title.reset();
                }
              }}
            />
          )}
        </Field>
        {!isFrame && (
          <Field label="Status">
            {(id) => (
              <select
                id={id}
                className="input"
                value={node.status ?? ''}
                onChange={(event) =>
                  patch({ status: (event.target.value || null) as Status | null })
                }
              >
                <option value="">No status</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label="Tags">
          {(id) => (
            <TagsEditor id={id} tags={node.tags ?? []} onChange={(tags) => patch({ tags })} />
          )}
        </Field>
        {isFrame && <FrameAccessField node={node} onChange={(props) => patch({ props })} />}
      </Section>

      <Section title="Description">
        <BodyEditor
          key={node.id}
          id={`body-${node.id}`}
          body={node.body ?? ''}
          onSave={(body) => patch({ body })}
        />
      </Section>

      <Section title="Comments">
        <NodeComments nodeId={node.id} />
      </Section>

      <Section title="Links">
        <LinksEditor
          nodeId={node.id}
          links={node.links ?? []}
          onChange={(links) => patch({ links })}
        />
      </Section>

      {props.length > 0 && (
        <Section title="Properties">
          <dl className="props-list">
            {props.map(([key, value]) => (
              <div key={key} className="props-row">
                <dt>{key}</dt>
                <dd title={JSON.stringify(value)}>
                  {typeof value === 'string' ? value : JSON.stringify(value)}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      <Section title="About">
        <IdRow id={node.id} kind="node" />
        <Provenance
          createdBy={node.createdBy}
          createdAt={node.createdAt}
          updatedBy={node.updatedBy}
          updatedAt={node.updatedAt}
        />
        <div className="inspector-actions">
          <Button size="sm" icon="copy" onClick={actions.duplicateSelection}>
            Duplicate
          </Button>
          <Button size="sm" variant="danger" icon="trash" onClick={actions.deleteSelection}>
            Delete
          </Button>
        </div>
      </Section>
    </div>
  );
}
