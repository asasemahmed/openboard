/** History batches as rows of the activity panel, and the words for an undo's outcome. */
import type { Batch, UndoResult } from '@openboard/core';

export type HistoryBadge = 'proposal' | 'undo' | 'undone';

export const BADGE_LABEL: Record<HistoryBadge, string> = {
  proposal: 'From proposal',
  undo: 'Undo',
  undone: 'Undone',
};

export interface HistoryRow {
  batch: Batch;
  badges: HistoryBadge[];
  /**
   * What the row's button does: undo this batch, or redo it by undoing the
   * batch that undid it. Undo batches themselves get no button; the row they
   * reverted carries "Redo".
   */
  action: { kind: 'undo' | 'redo'; batchId: string } | null;
  /** Nodes to point at when the row is hovered or clicked. */
  nodeIds: readonly string[];
}

export function historyRow(batch: Batch): HistoryRow {
  const badges: HistoryBadge[] = [];
  if (batch.proposalId) badges.push('proposal');
  if (batch.source === 'undo') badges.push('undo');
  if (batch.undoneBy) badges.push('undone');
  let action: HistoryRow['action'] = null;
  if (batch.source !== 'undo') {
    action = batch.undoneBy
      ? { kind: 'redo', batchId: batch.undoneBy }
      : { kind: 'undo', batchId: batch.id };
  }
  return { batch, badges, action, nodeIds: batch.nodeIds };
}

/** Merge a fresh page into the rows already shown: newest first, no duplicates, fresh wins. */
export function mergeBatches(current: readonly Batch[], fresh: readonly Batch[]): Batch[] {
  const byId = new Map<string, Batch>();
  for (const batch of current) byId.set(batch.id, batch);
  for (const batch of fresh) byId.set(batch.id, batch);
  return [...byId.values()].sort((a, b) => b.cursor - a.cursor || b.at.localeCompare(a.at));
}

/** Batches an "undo everything by" would revert. */
export function undoableBy(batches: readonly Batch[], actorId: string): Batch[] {
  return batches.filter((b) => b.actor === actorId && !b.undoneBy && b.source !== 'undo');
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Undone." / "Undone. Left 2 items as they are because they were changed afterwards." */
export function undoOutcome(
  result: Pick<UndoResult, 'undone' | 'conflicts'>,
  verb = 'Undone',
): string {
  const left = result.conflicts.length;
  const kept = left
    ? `Left ${plural(left, 'item')} as ${left === 1 ? 'it is' : 'they are'} because ${left === 1 ? 'it was' : 'they were'} changed afterwards.`
    : '';
  if (result.undone.length === 0)
    return left ? `Nothing was changed. ${kept}` : 'Nothing was left to change.';
  const head =
    result.undone.length > 1 ? `${verb} ${plural(result.undone.length, 'change')}.` : `${verb}.`;
  return kept ? `${head} ${kept}` : head;
}

/**
 * Replace the newest rows with a fresh read of them. Rows older than the
 * oldest fresh one (pages not re-read) are kept as they were.
 */
export function replaceNewest(
  current: readonly Batch[],
  fresh: readonly Batch[],
  complete: boolean,
): Batch[] {
  if (complete) return mergeBatches([], fresh);
  const oldest = fresh[fresh.length - 1];
  if (!oldest) return [...current];
  const kept = current.filter((b) => b.cursor < oldest.cursor);
  return mergeBatches(kept, fresh);
}
