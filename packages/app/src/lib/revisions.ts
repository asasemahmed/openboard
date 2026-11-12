/** The revision picker for "Compare with…": what to show for the board's git history. */
import type { Revision, RevisionsResult } from '@openboard/core';

export type RevisionPicker =
  | { state: 'untracked' }
  | { state: 'empty'; dirty: boolean }
  | { state: 'list'; dirty: boolean; revisions: readonly Revision[] };

export function revisionPicker(result: RevisionsResult): RevisionPicker {
  if (!result.tracked) return { state: 'untracked' };
  if (result.revisions.length === 0) return { state: 'empty', dirty: result.dirty };
  return { state: 'list', dirty: result.dirty, revisions: result.revisions };
}

/** What the comparison is against, for the banner. */
export interface CompareTarget {
  rev: string;
  short: string;
  subject: string;
}

export function compareTarget(revision: Revision): CompareTarget {
  return { rev: revision.rev, short: revision.short, subject: revision.subject };
}
