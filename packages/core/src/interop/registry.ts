/**
 * Every export and import format, by name, plus format detection from a file
 * name and its contents.
 */
import type { Board } from '../schema.js';
import { serializeBoard } from '../serialize.js';
import { fromJsonCanvas, toJsonCanvas } from './jsoncanvas.js';
import { toMarkdown } from './markdown.js';
import { toMermaid } from './mermaid.js';
import { fromMermaid } from './mermaid-import.js';
import { type SvgOptions, toSvg } from './svg.js';
import type { Exporter, Importer } from './types.js';

export const EXPORTERS: readonly Exporter[] = [
  {
    name: 'json',
    extension: '.json',
    mime: 'application/json',
    description: 'the board file, byte for byte as it is saved in .openboard/',
    render: (board: Board) => serializeBoard(board),
  },
  {
    name: 'markdown',
    extension: '.md',
    mime: 'text/markdown',
    description: 'a readable document: frames as headings, nodes as lists',
    render: (board, options) => toMarkdown(board, { bodies: options?.bodies !== false }),
  },
  {
    name: 'mermaid',
    extension: '.mmd',
    mime: 'text/vnd.mermaid',
    description: 'a Mermaid flowchart with frames as subgraphs',
    render: (board, options) =>
      toMermaid(board, { direction: options?.direction === 'LR' ? 'LR' : 'TD' }),
  },
  {
    name: 'jsoncanvas',
    extension: '.canvas',
    mime: 'application/json',
    description: 'JSON Canvas 1.0, as used by Obsidian',
    render: (board) => toJsonCanvas(board),
  },
  {
    name: 'svg',
    extension: '.svg',
    mime: 'image/svg+xml',
    description: 'a static picture of the board',
    render: (board, options) => toSvg(board, svgOptions(options)),
  },
];

export const IMPORTERS: readonly Importer[] = [
  {
    name: 'mermaid',
    extensions: ['.mmd', '.mermaid'],
    description: 'a Mermaid flowchart; subgraphs become frames',
    parse: fromMermaid,
  },
  {
    name: 'jsoncanvas',
    extensions: ['.canvas'],
    description: 'JSON Canvas 1.0; groups become frames',
    parse: fromJsonCanvas,
  },
];

/** Only the SVG options a caller can sensibly pass as plain values. */
function svgOptions(options: Record<string, unknown> | undefined): SvgOptions {
  if (!options) return {};
  const out: SvgOptions = {};
  if (options.theme === 'dark' || options.theme === 'light') out.theme = options.theme;
  if (typeof options.padding === 'number') out.padding = options.padding;
  if (typeof options.title === 'boolean') out.title = options.title;
  if (typeof options.maxWidth === 'number') out.maxWidth = options.maxWidth;
  if (typeof options.idPrefix === 'string') out.idPrefix = options.idPrefix;
  // A diff and the board before it are objects; they are passed through as given.
  if (typeof options.diff === 'object' && options.diff !== null) {
    out.diff = options.diff as SvgOptions['diff'];
  }
  if (typeof options.before === 'object' && options.before !== null) {
    out.before = options.before as Board;
  }
  return out;
}

export function findExporter(name: string): Exporter | undefined {
  return EXPORTERS.find((exporter) => exporter.name === name);
}

export function findImporter(name: string): Importer | undefined {
  return IMPORTERS.find((importer) => importer.name === name);
}

export type FormatName = 'json' | 'markdown' | 'mermaid' | 'jsoncanvas' | 'svg';

const BY_EXTENSION: Array<[string, FormatName]> = [
  ['.board.json', 'json'],
  ['.canvas', 'jsoncanvas'],
  ['.mermaid', 'mermaid'],
  ['.mmd', 'mermaid'],
  ['.markdown', 'markdown'],
  ['.md', 'markdown'],
  ['.svg', 'svg'],
];

/**
 * The format of a file, from its contents when they are telling and from its
 * extension otherwise. Returns undefined when neither says anything.
 */
export function detectFormat(filename: string, text: string): FormatName | undefined {
  const sniffed = sniff(text);
  if (sniffed) return sniffed;
  const lower = filename.toLowerCase();
  for (const [extension, format] of BY_EXTENSION) if (lower.endsWith(extension)) return format;
  if (lower.endsWith('.json')) return 'json';
  return undefined;
}

function sniff(text: string): FormatName | undefined {
  const head = text.replace(/^﻿/, '').trimStart();
  if (head.startsWith('{')) {
    try {
      const data = JSON.parse(head) as Record<string, unknown>;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
      if ('schemaVersion' in data && typeof data.nodes === 'object') return 'json';
      if (Array.isArray(data.nodes) || Array.isArray(data.edges)) return 'jsoncanvas';
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (/^<\?xml[^>]*>\s*<svg\b/i.test(head) || /^<svg\b/i.test(head)) return 'svg';
  // Mermaid: an optional front matter block and %% comments, then the diagram header.
  const lines = head.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end !== -1) i = end + 1;
  }
  for (; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (!line || line.startsWith('%%')) continue;
    return /^(flowchart|graph)\b/i.test(line) ? 'mermaid' : undefined;
  }
  return undefined;
}
