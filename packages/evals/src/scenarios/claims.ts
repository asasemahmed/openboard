import { touchedIds } from '../board.js';
import { check, claimedBeforeEditing, nodesUnchanged, sentOps, statusEquals } from '../checks.js';
import { idOf } from '../reference.js';
import type { Scenario } from '../types.js';
import { frame, keep, task } from './util.js';

export const HELPER_AGENT = { id: 'helper-agent', kind: 'agent' as const, name: 'Helper' };

export const sharedBoardClaims: Scenario = {
  id: 'shared-board-claims',
  title: 'Share the board with another agent',
  description:
    'Another agent holds a claim on one of two candidate tasks. The agent must take the unclaimed one, claim it before editing, and leave the claimed one alone.',
  tags: ['claims', 'multi-agent'],
  async setup(ctx) {
    await ctx.setPolicy('auto');
    const refs = await ctx.apply([
      frame('sprint', 'Sprint'),
      task('csv', 'Add CSV export', '$sprint'),
      task('pdf', 'Add PDF export', '$sprint'),
    ]);
    keep(ctx.ids, refs, ['sprint', 'csv', 'pdf']);
    const helper = ctx.api(HELPER_AGENT);
    const claim = await helper.claim(ctx.board, {
      nodeIds: [ctx.ids.csv as string],
      note: 'Writing the CSV export',
      minutes: 60,
    });
    if (claim.conflicts.length > 0) throw new Error('the helper could not claim the CSV task');
  },
  prompt:
    'Pick up one of the two export tasks in the Sprint frame that no one else is working on: claim it, then set it to in progress.',
  checks: [
    statusEquals('the PDF task is in progress', { key: 'pdf' }, 'in_progress', 2),
    nodesUnchanged('the claimed CSV task is untouched', [{ key: 'csv' }], 2),
    claimedBeforeEditing({ key: 'pdf' }, 2),
    check('did not try to take the claimed task', (ctx) => {
      const csv = ctx.ids.csv as string;
      const claims = ctx.trace.calls.filter(
        (c) =>
          c.tool === 'board_claim' && Array.isArray(c.args.nodeIds) && c.args.nodeIds.includes(csv),
      ).length;
      const edits = sentOps(ctx).filter(({ op }) => touchedIds(op).includes(csv)).length;
      return {
        pass: claims + edits === 0,
        score: claims + edits === 0 ? 1 : claims + edits === 1 ? 0.5 : 0,
        detail: `${claims} claim attempts and ${edits} edits on the claimed task`,
      };
    }),
  ],
  async reference({ call }) {
    const outline = await call('board_outline');
    const sprint = idOf(outline.text, 'Sprint');
    // Summary detail shows who holds a claim; titles do not.
    const read = await call('board_read', { frame: sprint });
    const pdf = idOf(read.text, 'Add PDF export');
    await call('board_claim', { nodeIds: [pdf], note: 'Starting the PDF export' });
    await call('board_apply', {
      reason: 'Start the PDF export',
      ops: [{ op: 'update_node', id: pdf, patch: { status: 'in_progress' } }],
    });
    return 'Claimed "Add PDF export" (the CSV export is claimed by Helper) and set it to in progress.';
  },
};
