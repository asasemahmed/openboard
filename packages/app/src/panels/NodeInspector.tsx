import { type BoardNode, LIMITS, type NodePatch, STATUSES, type Status } from '@openboard/core';
import { useCallback, useEffect, useRef } from 'react';
import { applyOrReport, useActions } from '../canvas/actions.js';
import { cardModel } from '../lib/declaredTypes.js';
import { typeProblems } from '../lib/fieldForm.js';
import { CARD_TYPES, STATUS_META, typeMeta } from '../lib/nodeTypes.js';
import { useCan } from '../state/access.js';
import { useSession } from '../state/context.js';
import { useNodeTypeDef, useTypes } from '../state/schema.js';
import { Button } from '../ui/Button.js';
import { TypeIcon } from '../ui/TypeIcon.js';
import { BodyEditor } from './BodyEditor.js';
import { ClaimSection } from './ClaimSection.js';
import { FrameAccessField } from './FrameAccessField.js';
import { Field, IdRow, Provenance, Section } from './fields.js';
import { LinksEditor } from './LinksEditor.js';
import { ReadOnlyNote } from './ReadOnlyNote.js';
import { TagsEditor } from './TagsEditor.js';
import { NodeComments } from './Threads.js';
import { TypeFields } from './TypeFields.js';
import { useDraft } from './useDraft.js';

export function NodeInspector({ node }: { node: BoardNode }) {
  const session = useSession();
  const actions = useActions();
  const meta = typeMeta(node.type);
  const isFrame = node.type === 'frame';
  const canEdit = useCan('board.edit');
  const def = useNodeTypeDef(node.type);
  const declared = useTypes().declaredNodes;
  const card = cardModel(node, def, meta);
  const problems = def ? typeProblems(node, def) : [];
  const rootRef = useRef<HTMLDivElement>(null);
  const typedTo = useRef<string | null>(null);

  // After switching to a declared type, go to the first field it still needs.
  useEffect(() => {
    if (typedTo.current !== node.type || !def) return;
    typedTo.current = null;
    rootRef.current
      ?.querySelector<HTMLElement>('.type-field.is-missing :is(input, select, textarea)')
      ?.focus();
  }, [node.type, def]);

  const patch = useCallback(
    (p: NodePatch) => applyOrReport(session, [{ op: 'update_node', id: node.id, patch: p }]),
    [session, node.id],
  );

  const title = useDraft(node.title, (next) => {
    const clean = next.replace(/\s+/g, ' ').trim();
    if (clean) patch({ title: clean });
    else title.reset();
  });

  const known =
    CARD_TYPES.includes(node.type as (typeof CARD_TYPES)[number]) ||
    declared.some((t) => t.type === node.type);
  const fieldKeys = new Set(def?.fields.map((f) => f.key) ?? []);
  const props = Object.entries(node.props ?? {}).filter(([key]) => !fieldKeys.has(key));
  const showStatus = !isFrame && (card.hasStatus || node.status !== undefined);

  return (
    <div className="inspector-node" ref={rootRef}>
      <ClaimSection nodeId={node.id} />
      {!canEdit && <ReadOnlyNote />}
      <fieldset className="inspector-fieldset" disabled={!canEdit}>
        <Section>
          <div className={`inspector-type ${card.toneClass}`}>
            {card.icon ? (
              <span className="type-glyph" aria-hidden="true">
                <TypeIcon name={card.icon} size={14} />
              </span>
            ) : (
              <span className="type-dot" aria-hidden="true" />
            )}
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
                  onChange={(event) => {
                    typedTo.current = event.target.value;
                    patch({ type: event.target.value });
                  }}
                >
                  {!known && <option value={node.type}>{typeMeta(node.type).name}</option>}
                  {CARD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {typeMeta(type).name}
                    </option>
                  ))}
                  {declared.length > 0 && (
                    <optgroup label="Declared types">
                      {declared.map((t) => (
                        <option key={t.type} value={t.type}>
                          {t.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
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
          {problems.length > 0 && (
            <div className="type-problems" role="status">
              <strong>Does not match {def?.label ?? 'its type'}.</strong>
              <ul>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {showStatus && (
            <Field
              label="Status"
              hint={card.hasStatus ? undefined : 'This type has no status. Clear it.'}
            >
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

        {def && def.fields.length > 0 && (
          <Section title="Fields">
            <TypeFields node={node} def={def} onProps={(props) => patch({ props })} />
            {def.description && <p className="field-hint type-about">{def.description}</p>}
          </Section>
        )}

        <Section title="Description">
          <BodyEditor
            key={node.id}
            id={`body-${node.id}`}
            body={node.body ?? ''}
            onSave={(body) => patch({ body })}
          />
        </Section>
      </fieldset>

      <Section title="Comments">
        <NodeComments nodeId={node.id} />
      </Section>

      <fieldset className="inspector-fieldset" disabled={!canEdit}>
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
      </fieldset>

      <Section title="About">
        <IdRow id={node.id} kind="node" />
        <Provenance
          createdBy={node.createdBy}
          createdAt={node.createdAt}
          updatedBy={node.updatedBy}
          updatedAt={node.updatedAt}
        />
        <div className="inspector-actions" hidden={!canEdit}>
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
