import type { Board } from '../schema.js';
import type { MergeConflict, MergeSide } from './types.js';

/** What every step of a merge works with. `base` is never null here. */
export interface MergeContext {
  base: Board;
  ours: Board;
  theirs: Board;
  prefer: MergeSide;
  /** Conflicts in the order they were found. */
  conflicts: MergeConflict[];
}

/** The title of a node on the first of `boards` that has it, for messages. */
export function titleIn(boards: readonly Board[], id: string): string {
  for (const board of boards) {
    const node = board.nodes[id];
    if (node) return node.title;
  }
  return id;
}
