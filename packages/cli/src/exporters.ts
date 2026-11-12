/**
 * Export formats: core's (`json`, `markdown`, `mermaid`, `canvas`, `svg`) plus
 * two text formats of the command line (`outline`, `text`), which render a
 * board the way the agent tools do.
 */
import {
  type Board,
  EXPORTERS as CORE_EXPORTERS,
  MAX_MAX_TOKENS,
  renderOutline,
  renderRead,
} from '@openboard/core';

export interface ExportOptions {
  /** For `svg`. */
  theme?: 'light' | 'dark';
}

export interface Exporter {
  name: string;
  /** Other names accepted by `--format`. */
  aliases: string[];
  /** File extensions, with the dot, the first one preferred. Used to guess the format from `--out`. */
  extensions: string[];
  description: string;
  render(board: Board, options?: ExportOptions): string;
}

/** Exports are not tied to a live session, so they carry no change-feed position. */
const EXPORT_CURSOR = 0;

/** Names and extensions the command line uses for core's formats. */
const CORE_NAMES: Record<string, { name: string; aliases: string[]; extensions?: string[] }> = {
  json: { name: 'json', aliases: [] },
  markdown: { name: 'markdown', aliases: ['md'], extensions: ['.md', '.markdown'] },
  mermaid: { name: 'mermaid', aliases: ['mmd'], extensions: ['.mmd', '.mermaid'] },
  jsoncanvas: { name: 'canvas', aliases: ['jsoncanvas'] },
  svg: { name: 'svg', aliases: [] },
};

/** The full text of every node, as an agent reads it at `full` detail. */
export function fullText(board: Board): string {
  return renderRead(board, Object.values(board.nodes), EXPORT_CURSOR, {
    detail: 'full',
    maxTokens: MAX_MAX_TOKENS,
  }).text;
}

/** The outline: frames and counts, as `board_outline` shows them. */
export function outlineText(board: Board): string {
  return renderOutline(board, EXPORT_CURSOR, { maxTokens: MAX_MAX_TOKENS }).text;
}

export const EXPORTERS: readonly Exporter[] = [
  ...CORE_EXPORTERS.map((core): Exporter => {
    const names = CORE_NAMES[core.name] ?? { name: core.name, aliases: [] };
    return {
      name: names.name,
      aliases: names.aliases,
      extensions: names.extensions ?? [core.extension],
      description: core.description,
      render: (board, options) =>
        core.render(board, options?.theme ? { theme: options.theme } : undefined),
    };
  }),
  {
    name: 'outline',
    aliases: [],
    extensions: ['.outline.txt'],
    description: 'frames and counts by type and status',
    render: outlineText,
  },
  {
    name: 'text',
    aliases: [],
    extensions: ['.txt'],
    description: 'every node in full, as an agent reads it',
    render: fullText,
  },
];

/** Every name `--format` accepts, aliases included. */
export const FORMAT_NAMES: readonly string[] = EXPORTERS.flatMap((e) => [e.name, ...e.aliases]);

export function findExporter(name: string): Exporter | undefined {
  return EXPORTERS.find((exporter) => exporter.name === name || exporter.aliases.includes(name));
}

/** The format whose extension matches the file name best (the longest match). */
export function exporterForFile(file: string): Exporter | undefined {
  const lower = file.toLowerCase();
  let best: { exporter: Exporter; length: number } | undefined;
  for (const exporter of EXPORTERS) {
    for (const extension of exporter.extensions) {
      if (lower.endsWith(extension) && extension.length > (best?.length ?? 0)) {
        best = { exporter, length: extension.length };
      }
    }
  }
  return best?.exporter;
}
