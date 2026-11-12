import { type BoardEdge, LIMITS } from '@openboard/core';
import { applyOrReport, useActions } from '../canvas/actions.js';
import { EDGE_TYPES, edgeMeta } from '../lib/edgeTypes.js';
import { typeMeta } from '../lib/nodeTypes.js';
import { useBoardNode, useSession } from '../state/context.js';
import { Button } from '../ui/Button.js';
import { Field, IdRow, Provenance, Section } from './fields.js';
import { useDraft } from './useDraft.js';

function Endpoint({ id, label }: { id: string; label: string }) {
  const { store } = useSession();
  const node = useBoardNode(id);
  if (!node) return null;
  const meta = typeMeta(node.type);
  return (
    <div className="edge-endpoint">
      <span className="field-label">{label}</span>
      <button
        type="button"
        className={`endpoint-btn tone-${meta.tone}`}
        onClick={() => store.select([id])}
        title="Select this node"
      >
        <span className="type-dot" aria-hidden="true" />
        <span className="endpoint-title">{node.title}</span>
      </button>
    </div>
  );
}

export function EdgeInspector({ edge }: { edge: BoardEdge }) {
  const session = useSession();
  const actions = useActions();
  const update = (patch: { type?: string; label?: string | null }) =>
    applyOrReport(session, [{ op: 'update_edge', id: edge.id, patch }]);
  const label = useDraft(edge.label ?? '', (next) => update({ label: next.trim() || null }));
  const options = EDGE_TYPES.includes(edge.type) ? EDGE_TYPES : [edge.type, ...EDGE_TYPES];

  return (
    <div className="inspector-edge">
      <Section>
        <p className="inspector-kicker">Connection</p>
        <Endpoint id={edge.source} label="From" />
        <Endpoint id={edge.target} label="To" />
        <Field label="Relationship">
          {(id) => (
            <select
              id={id}
              className="input"
              value={edge.type}
              onChange={(event) => update({ type: event.target.value })}
            >
              {options.map((type) => (
                <option key={type} value={type}>
                  {edgeMeta(type).label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Label">
          {(id) => (
            <input
              id={id}
              className="input"
              value={label.draft}
              maxLength={LIMITS.label}
              placeholder="Optional"
              onChange={(event) => label.change(event.target.value)}
              onBlur={() => label.save()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') label.save();
                if (event.key === 'Escape') label.reset();
              }}
            />
          )}
        </Field>
      </Section>
      <Section title="About">
        <IdRow id={edge.id} kind="edge" />
        <Provenance
          createdBy={edge.createdBy}
          createdAt={edge.createdAt}
          updatedBy={edge.updatedBy}
          updatedAt={edge.updatedAt}
        />
        <div className="inspector-actions">
          <Button size="sm" variant="danger" icon="trash" onClick={actions.deleteSelection}>
            Delete connection
          </Button>
        </div>
      </Section>
    </div>
  );
}
