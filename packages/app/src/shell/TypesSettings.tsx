/**
 * Settings → Types: the node and edge types this project declares, which
 * agents read through the schema and people see on cards and in forms.
 * Project types are edited here and saved in .openboard/config.json; types a
 * plugin brings are shown but belong to the plugin.
 */
import {
  type EdgeTypeDef,
  FIELD_KINDS,
  type FieldKind,
  type NodeTypeDef,
  type ProjectConfig,
  type SchemaEdgeType,
  type SchemaNodeType,
  TYPE_COLORS,
  TYPE_ICONS,
  TYPE_LIMITS,
} from '@openboard/core';
import { type ReactNode, useId, useState } from 'react';
import { calmMessage } from '../lib/api.js';
import { COLOR_NAMES } from '../lib/declaredTypes.js';
import {
  type Built,
  defFromDraft,
  draftFromDef,
  type EdgeDraft,
  EMPTY_FIELD,
  edgeDefFromDraft,
  edgeDraftFromDef,
  emptyType,
  type FieldDraft,
  keyFromLabel,
  moveField,
  roomFor,
  type TypeDraft,
  withEdgeType,
  withNodeType,
  withoutEdgeType,
  withoutNodeType,
} from '../lib/typeEditor.js';
import { StatusPill } from '../nodes/StatusPill.js';
import { useSession } from '../state/context.js';
import { refreshSchema, useTypes } from '../state/schema.js';
import { toasts } from '../state/toasts.js';
import { Button } from '../ui/Button.js';
import { Icon } from '../ui/Icon.js';
import { TypeIcon } from '../ui/TypeIcon.js';

const KIND_NAMES: Record<FieldKind, string> = {
  text: 'Text, one line',
  longtext: 'Long text',
  number: 'Number',
  boolean: 'Yes or no',
  select: 'One of a list',
  date: 'Date',
  url: 'Web address',
};

type Editing = { what: 'node'; type: string | null } | { what: 'edge'; type: string | null } | null;

export function TypesSettings({
  config,
  canWrite,
  onSaved,
  onClose,
}: {
  config: ProjectConfig;
  canWrite: boolean;
  onSaved: (config: ProjectConfig) => void;
  onClose: () => void;
}) {
  const session = useSession();
  const index = useTypes();
  const [editing, setEditing] = useState<Editing>(null);
  const nodeTypes = config.nodeTypes ?? {};
  const edgeTypes = config.edgeTypes ?? {};
  const pluginNodes = index.declaredNodes.filter((t) => t.source === 'plugin');
  const pluginEdges = index.declaredEdges.filter((t) => t.source === 'plugin');

  const save = async (next: ProjectConfig, message: string): Promise<string | null> => {
    try {
      const saved = await session.api.setConfig(next);
      onSaved(saved);
      await refreshSchema();
      toasts.show(message);
      return null;
    } catch (error) {
      return calmMessage(error, 'settings');
    }
  };

  if (editing?.what === 'node') {
    const previous = editing.type;
    const def = previous ? nodeTypes[previous] : undefined;
    return (
      <NodeTypeEditor
        key={previous ?? 'new'}
        initial={previous && def ? draftFromDef(previous, def) : emptyType()}
        existing={previous}
        taken={[...Object.keys(nodeTypes), ...pluginNodes.map((t) => t.type)]}
        canWrite={canWrite}
        onCancel={() => setEditing(null)}
        onSave={async (built) => {
          if (!built.def) return 'Fix the problems above first.';
          const error = await save(
            withNodeType(config, built.type, built.def, previous ?? undefined),
            `Saved the type ${built.def.label}.`,
          );
          if (!error) setEditing(null);
          return error;
        }}
        onDelete={
          previous
            ? async () => {
                const error = await save(withoutNodeType(config, previous), 'Deleted the type.');
                if (!error) setEditing(null);
                return error;
              }
            : undefined
        }
        usage={(type) => session.store.nodes.filter((n) => n.data.node.type === type).length}
      />
    );
  }
  if (editing?.what === 'edge') {
    const previous = editing.type;
    const def = previous ? edgeTypes[previous] : undefined;
    return (
      <EdgeTypeEditor
        key={previous ?? 'new'}
        initial={
          previous && def
            ? edgeDraftFromDef(previous, def)
            : { name: '', label: '', description: '', style: 'solid', directed: true }
        }
        existing={previous}
        taken={[...Object.keys(edgeTypes), ...pluginEdges.map((t) => t.type)]}
        canWrite={canWrite}
        onCancel={() => setEditing(null)}
        onSave={async (built) => {
          if (!built.def) return 'Fix the problems above first.';
          const error = await save(
            withEdgeType(config, built.type, built.def, previous ?? undefined),
            `Saved the connection type ${built.def.label}.`,
          );
          if (!error) setEditing(null);
          return error;
        }}
        onDelete={
          previous
            ? async () => {
                const error = await save(withoutEdgeType(config, previous), 'Deleted the type.');
                if (!error) setEditing(null);
                return error;
              }
            : undefined
        }
        usage={(type) =>
          [...session.store.boardEdges().values()].filter((e) => e.type === type).length
        }
      />
    );
  }

  return (
    <div className="types-settings">
      <p className="muted small">
        Types of your own, next to the built-in ones. Agents read them (with their descriptions)
        before they add to a board, and cards and the inspector follow them.
      </p>
      <TypeList
        title="Node types"
        empty="No node types declared yet."
        rows={Object.entries(nodeTypes).map(([type, def]) => ({
          type,
          label: def.label,
          detail: `${def.fields?.length ?? 0} field${def.fields?.length === 1 ? '' : 's'}`,
          lead: <DefLead color={def.color} icon={def.icon} />,
        }))}
        plugin={pluginNodes.map((t) => ({
          type: t.type,
          label: t.label,
          detail: `${t.fields.length} field${t.fields.length === 1 ? '' : 's'}`,
          plugin: t.plugin ?? 'a plugin',
          lead: <DefLead color={t.color} icon={t.icon} />,
        }))}
        canWrite={canWrite}
        canAdd={roomFor(config, 'node')}
        addLabel="New node type"
        onOpen={(type) => setEditing({ what: 'node', type })}
      />
      <TypeList
        title="Connection types"
        empty="No connection types declared yet."
        rows={Object.entries(edgeTypes).map(([type, def]) => ({
          type,
          label: def.label,
          detail: `${def.style ?? 'solid'}${def.directed === false ? ', both ways' : ''}`,
          lead: <EdgeLead def={def} />,
        }))}
        plugin={pluginEdges.map((t) => ({
          type: t.type,
          label: t.label,
          detail: `${t.style ?? 'solid'}${t.directed ? '' : ', both ways'}`,
          plugin: t.plugin ?? 'a plugin',
          lead: <EdgeLead def={t} />,
        }))}
        canWrite={canWrite}
        canAdd={roomFor(config, 'edge')}
        addLabel="New connection type"
        onOpen={(type) => setEditing({ what: 'edge', type })}
      />
      <div className="dialog-actions">
        <Button onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

function DefLead({ color, icon }: Pick<SchemaNodeType, 'color' | 'icon'>) {
  const tone = color ? `tone-c-${color}` : 'tone-custom';
  return icon ? (
    <span className={`type-glyph ${tone}`} aria-hidden="true">
      <TypeIcon name={icon} size={14} />
    </span>
  ) : (
    <span className={`type-dot ${tone}`} aria-hidden="true" />
  );
}

function EdgeLead({ def }: { def: Pick<SchemaEdgeType, 'style'> & { directed?: boolean } }) {
  const dash = def.style === 'dashed' ? '4 3' : undefined;
  const width = def.style === 'thick' ? 2.5 : 1.5;
  return (
    <svg width="24" height="12" viewBox="0 0 24 12" aria-hidden="true" className="edge-lead">
      <path d="M2 6h17" stroke="currentColor" strokeWidth={width} strokeDasharray={dash} />
      {def.directed !== false && (
        <path d="M16 2.5L20.5 6 16 9.5" fill="none" stroke="currentColor" strokeWidth={1.5} />
      )}
    </svg>
  );
}

interface Row {
  type: string;
  label: string;
  detail: string;
  lead: ReactNode;
  plugin?: string;
}

function TypeList({
  title,
  empty,
  rows,
  plugin,
  canWrite,
  canAdd,
  addLabel,
  onOpen,
}: {
  title: string;
  empty: string;
  rows: Row[];
  plugin: Row[];
  canWrite: boolean;
  canAdd: boolean;
  addLabel: string;
  onOpen: (type: string | null) => void;
}) {
  const id = useId();
  return (
    <section className="settings-section types-list" aria-labelledby={id}>
      <div className="types-list-head">
        <h3 id={id}>{title}</h3>
        {canWrite && (
          <Button
            size="sm"
            icon="plus"
            disabled={!canAdd}
            title={canAdd ? undefined : 'The project has as many as it can hold.'}
            onClick={() => onOpen(null)}
          >
            {addLabel}
          </Button>
        )}
      </div>
      {rows.length === 0 && plugin.length === 0 && <p className="muted small">{empty}</p>}
      <ul>
        {rows.map((row) => (
          <li key={row.type}>
            <button type="button" className="type-row" onClick={() => onOpen(row.type)}>
              {row.lead}
              <span className="type-row-name">{row.label}</span>
              <code className="type-row-id">{row.type}</code>
              <span className="type-row-detail">{row.detail}</span>
              <Icon name="chevronRight" />
            </button>
          </li>
        ))}
        {plugin.map((row) => (
          <li key={row.type}>
            <div className="type-row is-plugin">
              {row.lead}
              <span className="type-row-name">{row.label}</span>
              <code className="type-row-id">{row.type}</code>
              <span className="type-row-detail">From the plugin {row.plugin}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Node type editor ─────────────────────────────────────────────────────────

function NodeTypeEditor({
  initial,
  existing,
  taken,
  canWrite,
  onCancel,
  onSave,
  onDelete,
  usage,
}: {
  initial: TypeDraft;
  existing: string | null;
  taken: string[];
  canWrite: boolean;
  onCancel: () => void;
  onSave: (built: Built<NodeTypeDef>) => Promise<string | null>;
  onDelete: (() => Promise<string | null>) | undefined;
  usage: (type: string) => number;
}) {
  const [draft, setDraft] = useState(initial);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ids = {
    name: useId(),
    label: useId(),
    description: useId(),
    status: useId(),
  };
  const built = defFromDraft(draft);
  const clash = !existing && taken.includes(built.type) ? [`${built.type} already exists.`] : [];
  const problems = [...clash, ...built.problems];
  const set = (patch: Partial<TypeDraft>) => {
    setServerError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const setField = (index: number, patch: Partial<FieldDraft>) =>
    set({ fields: draft.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)) });

  const submit = async () => {
    setTried(true);
    if (problems.length > 0) return;
    setBusy(true);
    setServerError(await onSave(built));
    setBusy(false);
  };
  const used = existing ? usage(existing) : 0;

  return (
    <form
      className="type-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="type-editor-head">
        <button type="button" className="link-btn" onClick={onCancel}>
          <Icon name="arrowLeft" size={14} /> All types
        </button>
        <h3>{existing ? `Edit ${initial.label || existing}` : 'New node type'}</h3>
      </div>
      <fieldset className="inspector-fieldset type-editor-body" disabled={!canWrite || busy}>
        <div className="type-editor-main">
          <div className="type-editor-row">
            <div className="field">
              <label className="field-label" htmlFor={ids.label}>
                Label
              </label>
              <input
                id={ids.label}
                className="input"
                value={draft.label}
                maxLength={TYPE_LIMITS.label}
                placeholder="Persona"
                onChange={(event) => {
                  const label = event.target.value;
                  // The name follows the label until someone edits it.
                  const follow = !existing && draft.name === slug(draft.label);
                  set({ label, ...(follow ? { name: slug(label) } : {}) });
                }}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor={ids.name}>
                Name
              </label>
              <div className="prefixed-input">
                <span className="prefix" aria-hidden="true">
                  x:
                </span>
                <input
                  id={ids.name}
                  className="input"
                  value={draft.name}
                  maxLength={40}
                  readOnly={existing !== null}
                  aria-describedby={`${ids.name}-hint`}
                  placeholder="persona"
                  onChange={(event) => set({ name: event.target.value.toLowerCase() })}
                />
              </div>
              <p id={`${ids.name}-hint`} className="field-hint">
                {existing
                  ? 'The name stays: nodes and agents refer to it.'
                  : 'What nodes store and agents write. Custom types start with x: so they never clash with built-in ones.'}
              </p>
            </div>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={ids.description}>
              Description
            </label>
            <textarea
              id={ids.description}
              className="input"
              rows={2}
              maxLength={TYPE_LIMITS.description}
              value={draft.description}
              aria-describedby={`${ids.description}-hint`}
              placeholder="Someone we design for: who they are and what they need."
              onChange={(event) => set({ description: event.target.value })}
            />
            <p id={`${ids.description}-hint`} className="field-hint">
              Written for both people and agents: what this type is for, and when to use it.
            </p>
          </div>
          <ColorPicker value={draft.color} onChange={(color) => set({ color })} />
          <IconPicker value={draft.icon} onChange={(icon) => set({ icon })} />
          <label className="check-row" htmlFor={ids.status}>
            <input
              id={ids.status}
              type="checkbox"
              checked={draft.hasStatus}
              onChange={(event) => set({ hasStatus: event.target.checked })}
            />
            <span>
              Nodes of this type have a status
              <span className="muted small"> (to do, in progress, done…)</span>
            </span>
          </label>
          <FieldsEditor
            fields={draft.fields}
            onChange={(fields) => set({ fields })}
            setField={setField}
          />
        </div>
        <aside className="type-editor-preview" aria-label="Preview">
          <p className="field-label">Preview</p>
          <PreviewCard draft={draft} />
        </aside>
      </fieldset>
      {tried && problems.length > 0 && (
        <ul className="type-editor-problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {serverError && (
        <p className="inline-error" role="alert">
          {serverError}
        </p>
      )}
      {confirmDelete && existing && (
        <div className="type-delete-confirm" role="alert">
          <p>
            {used > 0
              ? `${used} node${used === 1 ? '' : 's'} on this board use${used === 1 ? 's' : ''} ${existing}. They keep their type and values but show as plain cards. Other boards may use it too.`
              : `No node on this board uses ${existing}. Other boards may.`}
          </p>
          <div className="dialog-actions">
            <Button size="sm" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (!onDelete) return;
                setBusy(true);
                void onDelete().then((error) => {
                  setBusy(false);
                  setServerError(error);
                });
              }}
            >
              Delete the type
            </Button>
          </div>
        </div>
      )}
      <div className="dialog-actions">
        {canWrite && onDelete && !confirmDelete && (
          <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)}>
            Delete…
          </Button>
        )}
        <span className="spacer" />
        <Button onClick={onCancel}>{canWrite ? 'Cancel' : 'Back'}</Button>
        {canWrite && (
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save type'}
          </Button>
        )}
      </div>
    </form>
  );
}

function slug(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 40);
}

function ColorPicker({
  value,
  onChange,
}: {
  value: TypeDraft['color'];
  onChange: (value: TypeDraft['color']) => void;
}) {
  const name = useId();
  return (
    <fieldset className="swatch-picker">
      <legend className="field-label">Colour</legend>
      <div className="swatches">
        <label className={`swatch swatch-none${value === null ? ' is-chosen' : ''}`} title="None">
          <input
            type="radio"
            name={name}
            className="visually-hidden"
            checked={value === null}
            aria-label="No colour"
            onChange={() => onChange(null)}
          />
          <span className="visually-hidden">None</span>
        </label>
        {TYPE_COLORS.map((color) => (
          <label
            key={color}
            className={`swatch tone-c-${color}${value === color ? ' is-chosen' : ''}`}
            title={COLOR_NAMES[color]}
          >
            <input
              type="radio"
              name={name}
              className="visually-hidden"
              checked={value === color}
              aria-label={COLOR_NAMES[color]}
              onChange={() => onChange(color)}
            />
            <span className="visually-hidden">{COLOR_NAMES[color]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function IconPicker({
  value,
  onChange,
}: {
  value: TypeDraft['icon'];
  onChange: (value: TypeDraft['icon']) => void;
}) {
  const name = useId();
  return (
    <fieldset className="icon-picker">
      <legend className="field-label">Icon</legend>
      <div className="icon-grid">
        <label className={`icon-choice${value === null ? ' is-chosen' : ''}`} title="No icon">
          <input
            type="radio"
            name={name}
            className="visually-hidden"
            checked={value === null}
            aria-label="No icon (a dot)"
            onChange={() => onChange(null)}
          />
          <span className="type-dot tone-custom" aria-hidden="true" />
          <span className="visually-hidden">No icon (a dot)</span>
        </label>
        {TYPE_ICONS.map((icon) => (
          <label
            key={icon}
            className={`icon-choice${value === icon ? ' is-chosen' : ''}`}
            title={icon}
          >
            <input
              type="radio"
              name={name}
              className="visually-hidden"
              checked={value === icon}
              onChange={() => onChange(icon)}
            />
            <TypeIcon name={icon} />
            <span className="visually-hidden">{icon}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function FieldsEditor({
  fields,
  onChange,
  setField,
}: {
  fields: FieldDraft[];
  onChange: (fields: FieldDraft[]) => void;
  setField: (index: number, patch: Partial<FieldDraft>) => void;
}) {
  const full = fields.length >= TYPE_LIMITS.fieldsPerType;
  return (
    <fieldset className="fields-editor">
      <legend className="field-label">Fields</legend>
      <p className="field-hint">
        Shown in the inspector as a form; the first two with a value show on the card. Values are
        stored in the node’s properties under the key.
      </p>
      <ol>
        {fields.map((field, index) => (
          <FieldRow
            // Rows keep no state of their own, so the position is a fine key.
            key={index}
            index={index}
            count={fields.length}
            field={field}
            onChange={(patch) => setField(index, patch)}
            onMove={(step) => onChange(moveField(fields, index, step))}
            onRemove={() => onChange(fields.filter((_, i) => i !== index))}
          />
        ))}
      </ol>
      <Button
        size="sm"
        icon="plus"
        disabled={full}
        onClick={() => onChange([...fields, { ...EMPTY_FIELD }])}
      >
        {full ? `At most ${TYPE_LIMITS.fieldsPerType} fields` : 'Add a field'}
      </Button>
    </fieldset>
  );
}

function FieldRow({
  index,
  count,
  field,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  field: FieldDraft;
  onChange: (patch: Partial<FieldDraft>) => void;
  onMove: (step: -1 | 1) => void;
  onRemove: () => void;
}) {
  const ids = {
    label: useId(),
    key: useId(),
    kind: useId(),
    options: useId(),
    description: useId(),
    required: useId(),
  };
  const n = index + 1;
  return (
    <li className="field-row">
      <div className="field-row-grid">
        <div className="field">
          <label className="field-label" htmlFor={ids.label}>
            Label
          </label>
          <input
            id={ids.label}
            className="input input-sm"
            value={field.label}
            maxLength={TYPE_LIMITS.label}
            placeholder="Story points"
            onChange={(event) => {
              const label = event.target.value;
              const follow = field.key === keyFromLabel(field.label);
              onChange({ label, ...(follow ? { key: keyFromLabel(label) } : {}) });
            }}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={ids.key}>
            Key
          </label>
          <input
            id={ids.key}
            className="input input-sm mono"
            value={field.key}
            maxLength={40}
            placeholder="storyPoints"
            spellCheck={false}
            onChange={(event) => onChange({ key: event.target.value })}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={ids.kind}>
            Kind
          </label>
          <select
            id={ids.kind}
            className="input input-sm"
            value={field.kind}
            onChange={(event) => onChange({ kind: event.target.value as FieldKind })}
          >
            {FIELD_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_NAMES[kind]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {field.kind === 'select' && (
        <div className="field">
          <label className="field-label" htmlFor={ids.options}>
            Options <span className="muted">(one per line)</span>
          </label>
          <textarea
            id={ids.options}
            className="input input-sm"
            rows={3}
            value={field.options}
            onChange={(event) => onChange({ options: event.target.value })}
          />
        </div>
      )}
      <div className="field">
        <label className="field-label" htmlFor={ids.description}>
          Description <span className="muted">(optional)</span>
        </label>
        <input
          id={ids.description}
          className="input input-sm"
          value={field.description}
          maxLength={TYPE_LIMITS.fieldDescription}
          placeholder="What goes here, for people and agents"
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </div>
      <div className="field-row-foot">
        <label className="check-row" htmlFor={ids.required}>
          <input
            id={ids.required}
            type="checkbox"
            checked={field.required}
            onChange={(event) => onChange({ required: event.target.checked })}
          />
          <span>Required</span>
        </label>
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label={`Move field ${n} up`}
          title="Move up"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <Icon name="arrowUp" />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label={`Move field ${n} down`}
          title="Move down"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          <Icon name="arrowDown" />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label={`Remove field ${n}`}
          title="Remove"
          onClick={onRemove}
        >
          <Icon name="trash" />
        </button>
      </div>
    </li>
  );
}

/** A card as the canvas will draw it, with sample values. */
function PreviewCard({ draft }: { draft: TypeDraft }) {
  const tone = draft.color ? `tone-c-${draft.color}` : 'tone-custom';
  const shown = draft.fields.filter((f) => f.label.trim()).slice(0, 2);
  return (
    <div className={`card is-declared type-preview ${tone}`} aria-hidden="true">
      <div className="card-inner">
        <header className="card-head">
          {draft.icon ? (
            <span className="type-glyph">
              <TypeIcon name={draft.icon} size={14} />
            </span>
          ) : (
            <span className="type-dot" />
          )}
          <span className="type-label">{draft.label.trim() || 'Label'}</span>
        </header>
        <h3 className="card-title lines-1">A {draft.label.trim().toLowerCase() || 'node'}</h3>
        {shown.length > 0 && (
          <div className="card-body card-fields">
            {shown.map((f) => (
              <p key={f.key || f.label} className="card-field">
                <span className="card-field-label">{f.label.trim()}:</span> {sample(f)}
              </p>
            ))}
          </div>
        )}
        {draft.hasStatus && (
          <div className="card-meta">
            <StatusPill status="todo" />
          </div>
        )}
      </div>
    </div>
  );
}

function sample(field: FieldDraft): string {
  switch (field.kind) {
    case 'number':
      return '3';
    case 'boolean':
      return 'yes';
    case 'date':
      return '2026-11-12';
    case 'url':
      return 'example.com/page';
    case 'select':
      return (
        field.options
          .split('\n')
          .find((o) => o.trim())
          ?.trim() ?? 'an option'
      );
    default:
      return 'Some text';
  }
}

// ── Edge type editor ─────────────────────────────────────────────────────────

function EdgeTypeEditor({
  initial,
  existing,
  taken,
  canWrite,
  onCancel,
  onSave,
  onDelete,
  usage,
}: {
  initial: EdgeDraft;
  existing: string | null;
  taken: string[];
  canWrite: boolean;
  onCancel: () => void;
  onSave: (built: Built<EdgeTypeDef>) => Promise<string | null>;
  onDelete: (() => Promise<string | null>) | undefined;
  usage: (type: string) => number;
}) {
  const [draft, setDraft] = useState(initial);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ids = { name: useId(), label: useId(), description: useId(), directed: useId() };
  const styleName = useId();
  const built = edgeDefFromDraft(draft);
  const clash = !existing && taken.includes(built.type) ? [`${built.type} already exists.`] : [];
  const problems = [...clash, ...built.problems];
  const set = (patch: Partial<EdgeDraft>) => {
    setServerError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const used = existing ? usage(existing) : 0;
  const submit = async () => {
    setTried(true);
    if (problems.length > 0) return;
    setBusy(true);
    setServerError(await onSave(built));
    setBusy(false);
  };

  return (
    <form
      className="type-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="type-editor-head">
        <button type="button" className="link-btn" onClick={onCancel}>
          <Icon name="arrowLeft" size={14} /> All types
        </button>
        <h3>{existing ? `Edit ${initial.label || existing}` : 'New connection type'}</h3>
      </div>
      <fieldset className="inspector-fieldset type-editor-single" disabled={!canWrite || busy}>
        <div className="type-editor-row">
          <div className="field">
            <label className="field-label" htmlFor={ids.label}>
              Label
            </label>
            <input
              id={ids.label}
              className="input"
              value={draft.label}
              maxLength={TYPE_LIMITS.label}
              placeholder="Supersedes"
              onChange={(event) => {
                const label = event.target.value;
                const follow = !existing && draft.name === slug(draft.label);
                set({ label, ...(follow ? { name: slug(label) } : {}) });
              }}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={ids.name}>
              Name
            </label>
            <div className="prefixed-input">
              <span className="prefix" aria-hidden="true">
                x:
              </span>
              <input
                id={ids.name}
                className="input"
                value={draft.name}
                maxLength={40}
                readOnly={existing !== null}
                placeholder="supersedes"
                onChange={(event) => set({ name: event.target.value.toLowerCase() })}
              />
            </div>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={ids.description}>
            Description
          </label>
          <textarea
            id={ids.description}
            className="input"
            rows={2}
            maxLength={TYPE_LIMITS.description}
            value={draft.description}
            placeholder="The source replaces the target."
            onChange={(event) => set({ description: event.target.value })}
          />
          <p className="field-hint">Written for both people and agents.</p>
        </div>
        <fieldset className="style-picker">
          <legend className="field-label">Line</legend>
          <div className="segmented">
            {(['solid', 'dashed', 'thick'] as const).map((style) => (
              <label key={style} className={draft.style === style ? 'is-active' : ''}>
                <input
                  type="radio"
                  name={styleName}
                  className="visually-hidden"
                  checked={draft.style === style}
                  onChange={() => set({ style })}
                />
                <EdgeLead def={{ style, directed: draft.directed }} />
                <span>{style}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="check-row" htmlFor={ids.directed}>
          <input
            id={ids.directed}
            type="checkbox"
            checked={draft.directed}
            onChange={(event) => set({ directed: event.target.checked })}
          />
          <span>
            Reads one way, from source to target
            <span className="muted small"> (drawn with an arrow)</span>
          </span>
        </label>
      </fieldset>
      {tried && problems.length > 0 && (
        <ul className="type-editor-problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {serverError && (
        <p className="inline-error" role="alert">
          {serverError}
        </p>
      )}
      {confirmDelete && existing && (
        <div className="type-delete-confirm" role="alert">
          <p>
            {used > 0
              ? `${used} connection${used === 1 ? '' : 's'} on this board use${used === 1 ? 's' : ''} ${existing}. They keep it but are drawn plainly. Other boards may use it too.`
              : `No connection on this board uses ${existing}. Other boards may.`}
          </p>
          <div className="dialog-actions">
            <Button size="sm" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (!onDelete) return;
                setBusy(true);
                void onDelete().then((error) => {
                  setBusy(false);
                  setServerError(error);
                });
              }}
            >
              Delete the type
            </Button>
          </div>
        </div>
      )}
      <div className="dialog-actions">
        {canWrite && onDelete && !confirmDelete && (
          <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)}>
            Delete…
          </Button>
        )}
        <span className="spacer" />
        <Button onClick={onCancel}>{canWrite ? 'Cancel' : 'Back'}</Button>
        {canWrite && (
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save type'}
          </Button>
        )}
      </div>
    </form>
  );
}
