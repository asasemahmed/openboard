import { LIMITS } from '@openboard/core';
import { useEffect, useRef, useState } from 'react';
import { useDraft } from './useDraft.js';

const SAVE_AFTER_MS = 800;

type Renderer = (source: string) => string;
let renderer: Renderer | null = null;
let loading: Promise<Renderer> | null = null;

/** The markdown renderer is loaded on first use, so it stays out of the initial bundle. */
function loadRenderer(): Promise<Renderer> {
  loading ??= import('../lib/markdown.js').then((m) => {
    renderer = m.renderMarkdown;
    return m.renderMarkdown;
  });
  return loading;
}

function useMarkdownHtml(source: string): string {
  const [, setLoaded] = useState(renderer !== null);
  useEffect(() => {
    if (!renderer && source) void loadRenderer().then(() => setLoaded(true));
  }, [source]);
  return renderer && source ? renderer(source) : '';
}

/** Markdown body with Write / Preview. Saves after a pause in typing and on blur. */
export function BodyEditor({
  id,
  body,
  onSave,
}: {
  id: string;
  body: string;
  onSave: (body: string | null) => void;
}) {
  const [mode, setMode] = useState<'write' | 'preview'>(body ? 'preview' : 'write');
  const { draft, change, save } = useDraft(body, (next) => onSave(next.trim() ? next : null));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const html = useMarkdownHtml(mode === 'preview' ? draft : '');

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        save();
      }
    },
    [save],
  );

  const schedule = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      save();
    }, SAVE_AFTER_MS);
  };

  return (
    <div className="body-editor">
      <div className="segmented" role="tablist" aria-label="Body view">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'write'}
          className={mode === 'write' ? 'is-active' : ''}
          onClick={() => setMode('write')}
        >
          Write
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'preview'}
          className={mode === 'preview' ? 'is-active' : ''}
          onClick={() => {
            if (timer.current) {
              clearTimeout(timer.current);
              timer.current = null;
              save();
            }
            setMode('preview');
          }}
        >
          Preview
        </button>
      </div>
      {mode === 'write' ? (
        <textarea
          id={id}
          className="input body-input"
          value={draft}
          maxLength={LIMITS.body}
          placeholder="Write in Markdown"
          rows={8}
          onChange={(event) => {
            change(event.target.value);
            schedule();
          }}
          onBlur={() => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            save();
          }}
        />
      ) : draft.trim() ? (
        <div
          id={id}
          className="markdown"
          // Rendered by markdown-it with raw HTML disabled; see lib/markdown.ts.
          dangerouslySetInnerHTML={{ __html: html }}
          onDoubleClick={() => setMode('write')}
        />
      ) : (
        <button id={id} type="button" className="markdown-empty" onClick={() => setMode('write')}>
          No description yet. Click to write one.
        </button>
      )}
    </div>
  );
}
