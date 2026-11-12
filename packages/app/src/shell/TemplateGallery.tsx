/**
 * A list of templates to pick one from, as radio cards: icon, name,
 * description, tags and what it adds. Used by "New board" and "Insert template".
 */
import type { TemplateSummary } from '@openboard/core';
import { useId } from 'react';
import { templateCounts, templateIcon } from '../lib/templateFlow.js';
import { TypeIcon } from '../ui/TypeIcon.js';

export function TemplateGallery({
  templates,
  value,
  onChange,
  label,
  empty,
  disabled = false,
}: {
  templates: readonly TemplateSummary[];
  value: string | null;
  onChange: (id: string | null) => void;
  label: string;
  /** Offer "Empty" first, standing for `null`. */
  empty?: { name: string; description: string };
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="template-gallery" disabled={disabled}>
      <legend className="field-label">{label}</legend>
      <div className="template-grid">
        {empty && (
          <label className={`template-card${value === null ? ' is-chosen' : ''}`}>
            <input
              type="radio"
              name={name}
              className="visually-hidden"
              checked={value === null}
              onChange={() => onChange(null)}
            />
            <span className="template-icon" aria-hidden="true">
              <TypeIcon name="box" />
            </span>
            <span className="template-text">
              <span className="template-name">{empty.name}</span>
              <span className="template-desc">{empty.description}</span>
            </span>
          </label>
        )}
        {templates.map((t) => (
          <label key={t.id} className={`template-card${value === t.id ? ' is-chosen' : ''}`}>
            <input
              type="radio"
              name={name}
              className="visually-hidden"
              checked={value === t.id}
              onChange={() => onChange(t.id)}
            />
            <span className="template-icon" aria-hidden="true">
              <TypeIcon name={templateIcon(t.id)} />
            </span>
            <span className="template-text">
              <span className="template-name">
                {t.name}
                {t.plugin && <span className="template-source"> · {t.plugin}</span>}
              </span>
              <span className="template-desc">{t.description}</span>
              <span className="template-meta">
                {templateCounts(t)}
                {t.tags.length > 0 && ` · ${t.tags.slice(0, 3).join(', ')}`}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
