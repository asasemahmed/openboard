/**
 * Core's text exporters for copying a board to the clipboard. Loaded on first
 * use, so the exporters stay out of the main bundle.
 */
import { type Board, toMarkdown, toMermaid } from '@openboard/core';

export function boardAsText(board: Board, format: 'mermaid' | 'markdown'): string {
  return format === 'mermaid' ? toMermaid(board) : toMarkdown(board, { bodies: true });
}
