/**
 * Markdown from board content, rendered by the sanitising renderer in
 * lib/markdown.ts (raw HTML off). The renderer loads on first use, so it
 * stays out of the initial bundle.
 */
import { useEffect, useState } from 'react';

type Renderer = (source: string) => string;
let renderer: Renderer | null = null;
let loading: Promise<Renderer> | null = null;

function loadRenderer(): Promise<Renderer> {
  loading ??= import('../lib/markdown.js').then((m) => {
    renderer = m.renderMarkdown;
    return m.renderMarkdown;
  });
  return loading;
}

export function useMarkdownHtml(source: string): string {
  const [, setLoaded] = useState(renderer !== null);
  useEffect(() => {
    if (!renderer && source) void loadRenderer().then(() => setLoaded(true));
  }, [source]);
  return renderer && source ? renderer(source) : '';
}

/** Rendered markdown; plain text until the renderer has loaded. */
export function Markdown({
  source,
  className = 'markdown',
}: {
  source: string;
  className?: string;
}) {
  const html = useMarkdownHtml(source);
  if (!html) return <div className={`${className} is-plain`}>{source}</div>;
  return (
    <div
      className={className}
      // Rendered by markdown-it with raw HTML disabled; see lib/markdown.ts.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
