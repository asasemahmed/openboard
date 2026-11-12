/**
 * The shapes the format registry is built from. An exporter turns a board into
 * text; an importer turns text into a batch of operations, so imported content
 * goes through the same validated apply path as any other change and can be
 * added to an existing board.
 */
import type { Op } from '../ops.js';
import type { Board } from '../schema.js';

export interface Exporter {
  /** Format name, e.g. `mermaid`. */
  name: string;
  /** File extension, with the dot. */
  extension: string;
  mime: string;
  /** One line for help output. */
  description: string;
  render(board: Board, options?: Record<string, unknown>): string;
}

export interface ImportResult {
  /**
   * One batch. New nodes are declared with `ref`s and connected through
   * `"$ref"`s, so the batch applies to any board, including an empty one.
   */
  ops: Op[];
  /** Things that were skipped or changed on the way in, one sentence each. */
  warnings: string[];
  /** A name for the board, when the source carries one. */
  name?: string;
}

export interface ImportOptions {
  maxOps?: number;
}

export interface Importer {
  name: string;
  /** File extensions, with the dot. */
  extensions: string[];
  description: string;
  /**
   * Never throws: anything it cannot read becomes a warning. The batch is cut
   * to `maxOps` operations (default `LIMITS.opsPerBatch`, what one public
   * batch may hold), with a warning.
   */
  parse(text: string, options?: ImportOptions): ImportResult;
}
