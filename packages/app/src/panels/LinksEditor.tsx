/**
 * A node's links: where each points, whether the code there is still what the
 * card describes (live from the document, with the server's detail), and what
 * can be done: open it in the editor, mark it up to date, edit, remove, add.
 */
import { LIMITS, type Link, type LinkEntry } from '@openboard/core';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { calmMessage } from '../lib/api.js';
import { type LinkView, linkViews } from '../lib/codeLinks.js';
import {
  absolutePath,
  editorUrl,
  lineRange,
  linkTargetProblem,
  readEditorScheme,
  safeHttpUrl,
} from '../lib/editor.js';
import { serverInfo } from '../state/boards.js';
import { useSession } from '../state/context.js';
import { useValue } from '../state/emitter.js';
import { toasts } from '../state/toasts.js';
import { Button } from '../ui/Button.js';
import { Icon, type IconName } from '../ui/Icon.js';

const KIND_ICON: Record<Link['kind'], IconName> = {
  file: 'file',
  symbol: 'code',
  commit: 'code',
  pr: 'code',
  url: 'globe',
};

const KIND_NAME: Record<Link['kind'], string> = {
  file: 'File',
  symbol: 'Symbol',
  commit: 'Commit',
  pr: 'Pull request',
  url: 'Web page',
};

type EditableKind = 'file' | 'symbol' | 'url';

/** The server's word on this node's links that need attention; re-read when they change. */
function useLinkEntries(nodeId: string, links: readonly Link[]): LinkEntry[] {
  const session = useSession();
  const [entries, setEntries] = useState<LinkEntry[]>([]);
  const key = links
    .map((l) => `${l.target}|${l.line ?? ''}|${l.hash ?? ''}|${l.stale ?? ''}`)
    .join('\n');
  useEffect(() => {
    if (!key) {
      setEntries([]);
      return;
    }
    let live = true;
    session.api
      .links(session.boardId, { stale: true })
      .then((result) => {
        if (live) setEntries(result.links.filter((e) => e.nodeId === nodeId));
      })
      .catch(() => {
        // Without the server the live state still shows; only the detail is missing.
      });
    return () => {
      live = false;
    };
  }, [session, nodeId, key]);
  return entries;
}

export function LinksEditor({
  nodeId,
  links,
  onChange,
}: {
  nodeId: string;
  links: readonly Link[];
  onChange: (links: Link[] | null) => void;
}) {
  const entries = useLinkEntries(nodeId, links);
  const views = linkViews({ id: nodeId, links: [...links] }, entries);
  const [editing, setEditing] = useState<number | 'new' | null>(null);

  const remove = (index: number) => {
    const next = links.filter((_, i) => i !== index);
    onChange(next.length > 0 ? next : null);
  };

  const save = (link: Link) => {
    if (editing === 'new') onChange([...links, link]);
    else if (typeof editing === 'number') onChange(links.map((l, i) => (i === editing ? link : l)));
    setEditing(null);
  };

  return (
    <div className="links">
      {views.length > 0 && (
        <ul className="links-list">
          {views.map((view) =>
            editing === view.index ? (
              <li key={`edit-${view.index}`} className="link-row-edit">
                <LinkForm initial={view.link} onSave={save} onCancel={() => setEditing(null)} />
              </li>
            ) : (
              <LinkRow
                key={`${view.index}:${view.link.kind}:${view.link.target}`}
                view={view}
                nodeId={nodeId}
                onEdit={() => setEditing(view.index)}
                onRemove={() => remove(view.index)}
              />
            ),
          )}
        </ul>
      )}
      {editing === 'new' ? (
        <LinkForm onSave={save} onCancel={() => setEditing(null)} />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          icon="plus"
          disabled={links.length >= LIMITS.linksPerNode}
          onClick={() => setEditing('new')}
        >
          Add link
        </Button>
      )}
    </div>
  );
}

function LinkRow({
  view,
  nodeId,
  onEdit,
  onRemove,
}: {
  view: LinkView;
  nodeId: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const session = useSession();
  const info = useValue(serverInfo);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { link } = view;
  const href = link.kind === 'url' ? safeHttpUrl(link.target) : null;
  const range = lineRange(link.line, link.endLine);
  const text = `${link.target}${range ? `:${range}` : ''}`;

  const open = async () => {
    const root = info?.root ?? '';
    const scheme = readEditorScheme();
    const kind = link.kind === 'symbol' ? 'symbol' : 'file';
    const url = root ? editorUrl(scheme, root, link.target, link.line, kind) : null;
    if (url) {
      window.location.href = url;
      return;
    }
    const path = (root && absolutePath(root, link.target, kind)) || link.target;
    try {
      await navigator.clipboard.writeText(path);
      toasts.show(`Copied the path: ${path}`);
    } catch {
      toasts.show('Copying is blocked in this browser. Select the path and copy it instead.', {
        tone: 'error',
      });
    }
  };

  const refresh = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await session.api.refreshLinks(session.boardId, { nodeIds: [nodeId] });
      if (result.status === 'proposed')
        setNote('Sent for review: an agent’s policy needs someone to accept the refreshed links.');
      else if (result.status === 'invalid')
        setNote(result.errors?.[0]?.message ?? 'The links could not be refreshed.');
      else setNote('Marked as up to date with the code as it is now.');
    } catch (error) {
      setNote(calmMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`link-row${view.warn ? ' is-stale' : ''}`}>
      <div className="link-main">
        <Icon name={KIND_ICON[link.kind]} />
        <span className="visually-hidden">{KIND_NAME[link.kind]}:</span>
        <span className="link-target" title={text}>
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {link.target}
            </a>
          ) : (
            link.target
          )}
          {range && <span className="link-lines">:{range}</span>}
        </span>
        <span className="link-actions">
          {view.canOpen && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label={`Open ${link.target} in the editor`}
              title="Open in editor"
              onClick={() => void open()}
            >
              <Icon name="external" />
            </button>
          )}
          {link.kind !== 'commit' && link.kind !== 'pr' && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label={`Edit link ${text}`}
              title="Edit link"
              onClick={onEdit}
            >
              <Icon name="edit" />
            </button>
          )}
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label={`Remove link ${text}`}
            title="Remove link"
            onClick={onRemove}
          >
            <Icon name="close" />
          </button>
        </span>
      </div>
      {view.status && (
        <div className={`link-state state-${view.state}`}>
          <Icon name={view.warn ? 'warning' : view.state === 'ok' ? 'check' : 'idle'} size={12} />
          <span>{view.status}</span>
          {view.canRefresh && (
            <button
              type="button"
              className="link-btn"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Mark as up to date
            </button>
          )}
        </div>
      )}
      {note && (
        <p className="link-note" role="status">
          {note}
        </p>
      )}
    </li>
  );
}

function LinkForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Link;
  onSave: (link: Link) => void;
  onCancel: () => void;
}) {
  const info = useValue(serverInfo);
  const editable = (k: Link['kind'] | undefined): EditableKind =>
    k === 'symbol' || k === 'url' ? k : 'file';
  const [kind, setKind] = useState<EditableKind>(editable(initial?.kind));
  const [target, setTarget] = useState(initial?.target ?? '');
  const [line, setLine] = useState(initial?.line ? String(initial.line) : '');
  const [endLine, setEndLine] = useState(initial?.endLine ? String(initial.endLine) : '');
  const [error, setError] = useState<string | null>(null);
  const ids = { kind: useId(), target: useId(), line: useId(), end: useId() };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problem = linkTargetProblem(kind, target);
    if (problem) return setError(problem);
    const value = target.trim().slice(0, 500);
    const link: Link = { kind, target: kind === 'url' ? (safeHttpUrl(value) ?? value) : value };
    if (kind !== 'url') {
      const start = Number.parseInt(line, 10);
      const end = Number.parseInt(endLine, 10);
      if (line && !(start > 0)) return setError('The first line is a number from 1.');
      if (endLine && !line) return setError('Give the first line too.');
      if (start > 0) link.line = start;
      if (end > 0) {
        if (end < start) return setError('The last line comes after the first.');
        if (end !== start) link.endLine = end;
      }
      // Same place, same hash: keep it so the link stays checked; anywhere new is hashed again.
      if (
        initial?.hash &&
        initial.target === link.target &&
        initial.line === link.line &&
        initial.endLine === link.endLine
      )
        link.hash = initial.hash;
    }
    onSave(link);
  };

  return (
    <form className="link-form" onSubmit={submit}>
      <div className="link-form-row">
        <label htmlFor={ids.kind} className="visually-hidden">
          Link kind
        </label>
        <select
          id={ids.kind}
          className="input input-sm link-form-kind"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as EditableKind);
            setError(null);
          }}
        >
          <option value="file">File</option>
          <option value="symbol">Symbol</option>
          <option value="url">Web page</option>
        </select>
        <label htmlFor={ids.target} className="visually-hidden">
          {kind === 'url' ? 'Address' : kind === 'symbol' ? 'File and symbol' : 'File path'}
        </label>
        <input
          id={ids.target}
          className="input input-sm link-form-target"
          value={target}
          data-autofocus
          placeholder={
            kind === 'url'
              ? 'https://…'
              : kind === 'symbol'
                ? 'src/api.ts#createUser'
                : 'src/payments/retry.ts'
          }
          onChange={(event) => {
            setTarget(event.target.value);
            setError(null);
          }}
        />
      </div>
      {kind !== 'url' && (
        <div className="link-form-row">
          <label htmlFor={ids.line} className="link-form-label">
            Lines
          </label>
          <input
            id={ids.line}
            className="input input-sm link-form-line"
            inputMode="numeric"
            placeholder="From"
            value={line}
            onChange={(event) => setLine(event.target.value.replace(/\D/g, ''))}
          />
          <label htmlFor={ids.end} className="visually-hidden">
            To line
          </label>
          <input
            id={ids.end}
            className="input input-sm link-form-line"
            inputMode="numeric"
            placeholder="To"
            value={endLine}
            onChange={(event) => setEndLine(event.target.value.replace(/\D/g, ''))}
          />
        </div>
      )}
      {kind !== 'url' && info?.root && (
        <p className="field-hint">
          Relative to the project root <code>{info.root}</code>
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="link-form-actions">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" type="submit" variant="primary">
          {initial ? 'Save link' : 'Add link'}
        </Button>
      </div>
    </form>
  );
}
