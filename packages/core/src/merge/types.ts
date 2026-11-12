import type { Board } from '../schema.js';

export type MergeSide = 'ours' | 'theirs';

export interface MergeOptions {
  /** Which side wins a conflict. Default `ours`. */
  prefer?: MergeSide;
}

/**
 * Something the merge had to decide for a person. The merged board already
 * holds the resolution; the conflict says what was decided and why.
 *
 * - `ours` / `theirs`: both sides changed the same field differently; that side's value was kept.
 * - `kept`: one side removed it and the other changed it; it was kept.
 * - `dropped`: it could not stay (an edge whose node is gone, a duplicate edge).
 * - `repaired`: the structure was fixed (a node taken out of a frame that is gone, a cycle broken).
 */
export interface MergeConflict {
  kind: 'node' | 'edge' | 'comment' | 'meta' | 'structure';
  id: string;
  field?: string;
  ours?: unknown;
  theirs?: unknown;
  resolution: 'ours' | 'theirs' | 'kept' | 'dropped' | 'repaired';
  /** One sentence a person can act on. */
  message: string;
}

export interface MergeResult {
  board: Board;
  conflicts: MergeConflict[];
  /** True when nothing needed a decision. */
  clean: boolean;
}
