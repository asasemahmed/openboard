/**
 * Export formats. To add one, add an entry to `EXPORTERS`.
 */
import {
  type Board,
  MAX_MAX_TOKENS,
  renderOutline,
  renderRead,
  serializeBoard,
} from '@openboard/core';

export interface Exporter {
  name: string;
  /** File extension, with the dot. Used to guess the format from `--out`. */
  extension: string;
  description: string;
  render(board: Board): string;
}

/** Exports are not tied to a live session, so they carry no change-feed position. */
const EXPORT_CURSOR = 0;

export const EXPORTERS: readonly Exporter[] = [
  {
    name: 'json',
    extension: '.json',
    description: 'the board file, byte for byte as it is saved in .openboard/',
    render: (board) => serializeBoard(board),
  },
  {
    name: 'outline',
    extension: '.outline.txt',
    description: 'frames and counts by type and status',
    render: (board) => renderOutline(board, EXPORT_CURSOR, { maxTokens: MAX_MAX_TOKENS }).text,
  },
  {
    name: 'text',
    extension: '.txt',
    description: 'every node in full, as an agent reads it',
    render: (board) =>
      renderRead(board, Object.values(board.nodes), EXPORT_CURSOR, {
        detail: 'full',
        maxTokens: MAX_MAX_TOKENS,
      }).text,
  },
];

export function findExporter(name: string): Exporter | undefined {
  return EXPORTERS.find((exporter) => exporter.name === name);
}

/** The format whose extension matches the file name best (the longest match). */
export function exporterForFile(file: string): Exporter | undefined {
  const lower = file.toLowerCase();
  return [...EXPORTERS]
    .sort((a, b) => b.extension.length - a.extension.length)
    .find((exporter) => lower.endsWith(exporter.extension));
}
