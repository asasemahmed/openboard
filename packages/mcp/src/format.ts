/**
 * The short lines the tools add around the API's own `text`: apply results,
 * board lists, notices and errors. Every line here costs tokens on every call
 * that produces it, so each says one thing.
 */
import type { AppliedOps, ApplyResult, BoardSummary, ChangesResult } from '@openboard/core';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Ids of new nodes listed in an apply result before the rest are counted. */
const MAX_LISTED_IDS = 20;

function counts(nodes: number, edges: number): string[] {
  const parts: string[] = [];
  if (nodes > 0) parts.push(plural(nodes, 'node'));
  if (edges > 0) parts.push(plural(edges, 'edge'));
  return parts;
}

/** "added 4 nodes, 2 edges; removed 1 edge", or "no changes". */
export function describeApplied(applied: AppliedOps): string {
  const groups: string[] = [];
  const add = (verb: string, nodes: string[], edges: string[]) => {
    const parts = counts(nodes.length, edges.length);
    if (parts.length > 0) groups.push(`${verb} ${parts.join(', ')}`);
  };
  add('added', applied.addedNodes, applied.addedEdges);
  add('updated', applied.updatedNodes, applied.updatedEdges);
  add('removed', applied.removedNodes, applied.removedEdges);
  return groups.length > 0 ? groups.join('; ') : 'no changes';
}

export function formatApply(result: ApplyResult): { text: string; isError: boolean } {
  switch (result.status) {
    case 'invalid': {
      const errors = [...(result.errors ?? [])].sort((a, b) => a.index - b.index);
      const lines = [`The batch was refused (${plural(errors.length, 'problem')}):`];
      for (const error of errors) lines.push(`ops[${error.index}]: ${error.message}`);
      lines.push('Nothing was applied. Fix these and send the whole batch again.');
      return { text: lines.join('\n'), isError: true };
    }
    case 'valid': {
      const what = result.applied ? describeApplied(result.applied) : 'no changes';
      return {
        text: `Dry run: the batch is valid (${what}). Nothing was changed.`,
        isError: false,
      };
    }
    case 'proposed':
      return {
        text: `Proposed${result.proposalId ? ` as ${result.proposalId}` : ''}: waiting for a person to accept it; nothing is on the board yet. Cursor ${result.cursor}.`,
        isError: false,
      };
    default: {
      const applied = result.applied;
      const lines = [
        `Applied: ${applied ? describeApplied(applied) : 'done'}. Cursor ${result.cursor}.`,
      ];
      const refs = Object.entries(result.refs);
      if (refs.length > 0)
        lines.push(`Refs: ${refs.map(([ref, id]) => `${ref}=${id}`).join(', ')}`);
      if (applied) {
        const byRef = new Set(Object.values(result.refs));
        const unnamed = applied.addedNodes.filter((id) => !byRef.has(id));
        if (unnamed.length > 0) {
          const shown = unnamed.slice(0, MAX_LISTED_IDS).join(', ');
          const more =
            unnamed.length > MAX_LISTED_IDS ? ` (+${unnamed.length - MAX_LISTED_IDS})` : '';
          lines.push(`New node ids: ${shown}${more}`);
        }
      }
      return { text: lines.join('\n'), isError: false };
    }
  }
}

export function formatBoards(boards: BoardSummary[], defaultBoard: string | undefined): string {
  if (boards.length === 0) return 'No boards yet. Create one with board_create.';
  return boards
    .map(
      (b) =>
        `${b.id} ${JSON.stringify(b.name)}: ${plural(b.nodeCount, 'node')}, ${plural(b.edgeCount, 'edge')}${b.id === defaultBoard ? ' (default)' : ''}`,
    )
    .join('\n');
}

/** How many changes a `changes` result covers, including the ones its budget left out. */
export function changeCount(result: ChangesResult): number {
  const match = /: (\d+) changes? since cursor/.exec(result.text);
  const counted = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(counted)
    ? Math.max(counted, result.changes.length)
    : result.changes.length;
}

export function othersNotice(count: number): string {
  return `Note: ${plural(count, 'change')} by others since your last read; call board_changes to see them.`;
}

export const RESYNC_NOTICE =
  'Note: the board changed more than its history keeps since your last read; call board_outline to re-read it.';
