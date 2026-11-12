import { LIMITS, type Link } from '@openboard/core';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '../ui/Button.js';
import { Icon, type IconName } from '../ui/Icon.js';

const KIND_ICON: Record<Link['kind'], IconName> = {
  file: 'file',
  symbol: 'code',
  commit: 'code',
  pr: 'code',
  url: 'globe',
};

function describe(link: Link): string {
  if (link.kind === 'file' && link.line) {
    return `${link.target}:${link.line}${link.endLine ? `-${link.endLine}` : ''}`;
  }
  return link.target;
}

function safeHref(link: Link): string | undefined {
  if (link.kind !== 'url') return undefined;
  try {
    const url = new URL(link.target);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function LinksEditor({
  links,
  onChange,
}: {
  links: readonly Link[];
  onChange: (links: Link[] | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<'file' | 'url'>('file');
  const [target, setTarget] = useState('');
  const [line, setLine] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ids = { kind: useId(), target: useId(), line: useId() };

  const remove = (index: number) => {
    const next = links.filter((_, i) => i !== index);
    onChange(next.length > 0 ? next : null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = target.trim();
    if (!value) return setError('Enter a path or address.');
    if (kind === 'url') {
      try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
          return setError('Use an http or https address.');
      } catch {
        return setError('That is not a full address. Include https://');
      }
    }
    const link: Link = { kind, target: value.slice(0, 500) };
    const lineNumber = Number.parseInt(line, 10);
    if (kind === 'file' && Number.isInteger(lineNumber) && lineNumber > 0) link.line = lineNumber;
    onChange([...links, link]);
    setTarget('');
    setLine('');
    setError(null);
    setAdding(false);
  };

  return (
    <div className="links">
      {links.length > 0 && (
        <ul className="links-list">
          {links.map((link, index) => {
            const href = safeHref(link);
            const text = describe(link);
            return (
              <li
                key={`${index}:${link.kind}:${link.target}`}
                className={`link-row${link.stale ? ' is-stale' : ''}`}
              >
                <Icon name={KIND_ICON[link.kind]} />
                <span className="link-target" title={text}>
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                      {text}
                    </a>
                  ) : (
                    text
                  )}
                </span>
                {link.stale && (
                  <span
                    className="stale-badge"
                    title="The target changed or disappeared since this link was made"
                  >
                    <Icon name="warning" size={12} />
                    Changed
                  </span>
                )}
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  aria-label={`Remove link ${text}`}
                  title="Remove link"
                  onClick={() => remove(index)}
                >
                  <Icon name="close" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <form className="link-form" onSubmit={submit}>
          <div className="link-form-row">
            <label htmlFor={ids.kind} className="visually-hidden">
              Link kind
            </label>
            <select
              id={ids.kind}
              className="input input-sm"
              value={kind}
              onChange={(event) => setKind(event.target.value as 'file' | 'url')}
            >
              <option value="file">File</option>
              <option value="url">URL</option>
            </select>
            <label htmlFor={ids.target} className="visually-hidden">
              {kind === 'file' ? 'File path' : 'Address'}
            </label>
            <input
              id={ids.target}
              className="input input-sm link-form-target"
              value={target}
              data-autofocus
              placeholder={kind === 'file' ? 'src/payments/retry.ts' : 'https://…'}
              onChange={(event) => setTarget(event.target.value)}
            />
            {kind === 'file' && (
              <>
                <label htmlFor={ids.line} className="visually-hidden">
                  Line
                </label>
                <input
                  id={ids.line}
                  className="input input-sm link-form-line"
                  inputMode="numeric"
                  placeholder="Line"
                  value={line}
                  onChange={(event) => setLine(event.target.value.replace(/\D/g, ''))}
                />
              </>
            )}
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="link-form-actions">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button size="sm" type="submit" variant="primary">
              Add link
            </Button>
          </div>
        </form>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          icon="plus"
          disabled={links.length >= LIMITS.linksPerNode}
          onClick={() => setAdding(true)}
        >
          Add link
        </Button>
      )}
    </div>
  );
}
