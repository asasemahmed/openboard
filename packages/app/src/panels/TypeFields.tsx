/**
 * The inspector form for a declared type: one control per field, written to
 * `props[key]` on commit. A value that does not fit is not written; the
 * reason stays next to the control until it is fixed or reset.
 */
import type { BoardNode, FieldDef, Json, SchemaNodeType } from '@openboard/core';
import { type ReactNode, useId, useState } from 'react';
import { inputValue, parseInput, propsWith } from '../lib/fieldForm.js';
import { useDraft } from './useDraft.js';

export function TypeFields({
  node,
  def,
  onProps,
}: {
  node: BoardNode;
  def: SchemaNodeType;
  onProps: (props: Record<string, Json> | null) => void;
}) {
  if (def.fields.length === 0) return null;
  return (
    <div className="type-fields">
      {def.fields.map((field) => (
        <FieldControl
          key={`${node.id}:${field.key}`}
          field={field}
          value={node.props?.[field.key]}
          onCommit={(value) => onProps(propsWith(node.props, field.key, value))}
        />
      ))}
    </div>
  );
}

function FieldControl({
  field,
  value,
  onCommit,
}: {
  field: FieldDef;
  value: Json | undefined;
  onCommit: (value: Json | undefined) => void;
}) {
  const id = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const shown = inputValue(field, value);
  const saved = useDraft<string | boolean>(shown, (next) => {
    const parsed = parseInput(field, next);
    setProblem(parsed.problem);
    if (parsed.problem) return;
    onCommit(parsed.value);
  });

  // Typing clears the last complaint; the value is checked again on commit.
  const draft = {
    ...saved,
    change: (next: string | boolean) => {
      setProblem(null);
      saved.change(next);
    },
  };
  const commitNow = (next: string | boolean) => {
    draft.change(next);
    draft.save(next);
  };
  const reset = () => {
    draft.reset();
    setProblem(null);
  };
  const errorId = `${id}-problem`;
  const hintId = `${id}-hint`;
  const describedBy = [problem ? errorId : '', field.description ? hintId : '']
    .filter(Boolean)
    .join(' ');
  const common = {
    id,
    'aria-invalid': problem ? true : undefined,
    'aria-describedby': describedBy || undefined,
    'aria-required': field.required ? true : undefined,
  } as const;
  const text = typeof draft.draft === 'string' ? draft.draft : '';

  let control: ReactNode;
  switch (field.kind) {
    case 'boolean':
      control = (
        <input
          {...common}
          type="checkbox"
          className="checkbox"
          checked={draft.draft === true}
          onChange={(event) => commitNow(event.target.checked)}
        />
      );
      break;
    case 'select':
      control = (
        <select
          {...common}
          className="input"
          value={text}
          onChange={(event) => commitNow(event.target.value)}
        >
          <option value="">{field.required ? 'Choose…' : 'None'}</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
          {text && !(field.options ?? []).includes(text) && (
            <option value={text}>{text} (not an option)</option>
          )}
        </select>
      );
      break;
    case 'longtext':
      control = (
        <textarea
          {...common}
          className="input"
          rows={3}
          value={text}
          onChange={(event) => draft.change(event.target.value)}
          onBlur={() => draft.save()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') reset();
          }}
        />
      );
      break;
    default:
      control = (
        <input
          {...common}
          className="input"
          type={field.kind === 'date' ? 'date' : field.kind === 'url' ? 'url' : 'text'}
          inputMode={field.kind === 'number' ? 'decimal' : undefined}
          value={text}
          onChange={(event) => {
            draft.change(event.target.value);
            if (field.kind === 'date') draft.save(event.target.value);
          }}
          onBlur={() => draft.save()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              draft.save();
            } else if (event.key === 'Escape') {
              reset();
            }
          }}
        />
      );
  }

  return (
    <div
      className={`field type-field kind-${field.kind}${problem ? ' has-problem' : ''}${
        field.required && (value === undefined || value === null || value === '')
          ? ' is-missing'
          : ''
      }`}
    >
      <label htmlFor={id} className="field-label">
        {field.label}
        {field.required && (
          <span className="required-mark" title="Required">
            {' '}
            *<span className="visually-hidden"> (required)</span>
          </span>
        )}
      </label>
      {control}
      {problem && (
        <div id={errorId} className="field-error" role="alert">
          {problem}
        </div>
      )}
      {field.description && (
        <div id={hintId} className="field-hint">
          {field.description}
        </div>
      )}
    </div>
  );
}
