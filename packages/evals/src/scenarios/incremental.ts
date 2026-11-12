import { check, statusEquals } from '../checks.js';
import { idOf } from '../reference.js';
import type { Scenario } from '../types.js';
import { frame, keep, node, task } from './util.js';

const EDITS_AFTER = { afterCalls: 1, tools: ['board_read'], afterMs: 60_000 };

export const incrementalUpdate: Scenario = {
  id: 'incremental-update',
  title: 'Catch up with board_changes',
  description:
    'After the agent first reads the frame, the person edits two tasks. The agent must learn what changed with board_changes, not by re-reading, and record it in the summary note.',
  tags: ['changes', 'read', 'budget'],
  async setup(ctx) {
    const refs = await ctx.apply(
      [
        frame('f', 'Release 1.2'),
        task('dark', 'Ship dark mode', '$f', 'in_progress'),
        task('redirect', 'Fix login redirect', '$f'),
        task('changelog', 'Update changelog', '$f'),
        task('api', 'Bump API version', '$f'),
        task('notes', 'Write release notes', '$f'),
        node('summary', 'note', 'Release summary', {
          parent: '$f',
          body: 'Nothing has changed yet.',
        }),
      ],
      { as: ctx.agent },
    );
    keep(ctx.ids, refs, ['f', 'dark', 'redirect', 'changelog', 'api', 'notes', 'summary']);
  },
  human: {
    events: [
      {
        name: 'finishes the redirect fix',
        at: EDITS_AFTER,
        action: { kind: 'edit', node: { key: 'redirect' }, patch: { status: 'done' } },
      },
      {
        name: 'renames the API task',
        at: EDITS_AFTER,
        action: { kind: 'edit', node: { key: 'api' }, patch: { title: 'Bump API version to v3' } },
      },
    ],
  },
  prompt:
    'People are editing the "Release 1.2" frame while you work. Read the frame, then find out what changed since you read it and update the body of the "Release summary" note to list each of those changes.',
  checks: [
    check(
      'caught up with board_changes after the edits',
      (ctx) => {
        const read = ctx.trace.calls.findIndex((c) => c.tool === 'board_read');
        const changes = ctx.trace.calls.slice(read + 1).find((c) => c.tool === 'board_changes');
        return {
          pass: read >= 0 && changes !== undefined,
          detail: changes
            ? `board_changes at #${changes.seq}`
            : 'board_changes not called after the first read',
        };
      },
      2,
    ),
    check(
      'the summary lists both changes',
      (ctx) => {
        const body = ctx.board.nodes[ctx.ids.summary ?? '']?.body ?? '';
        const found = [/login redirect/i.test(body), /v3/i.test(body)];
        const n = found.filter(Boolean).length;
        return {
          pass: n === 2,
          score: n / 2,
          detail: `${n} of 2 changes in the summary: ${JSON.stringify(body.slice(0, 200))}`,
        };
      },
      2,
    ),
    check('did not re-read the frame to find the changes', (ctx) => {
      const first = ctx.trace.calls.findIndex((c) => c.tool === 'board_read');
      const rereads = ctx.trace.calls
        .slice(first + 1)
        .filter(
          (c) => c.tool === 'board_read' && !Array.isArray(c.args.ids) && c.args.text === undefined,
        );
      return {
        pass: rereads.length === 0,
        detail:
          rereads.length === 0
            ? 'no broad re-read'
            : `${rereads.length} broad re-reads (#${rereads.map((c) => c.seq).join(', #')})`,
      };
    }),
    statusEquals('kept the person’s edit', { key: 'redirect' }, 'done'),
  ],
  async reference({ call }) {
    const outline = await call('board_outline');
    const frameId = idOf(outline.text, 'Release 1.2');
    const read = await call('board_read', { frame: frameId, detail: 'titles' });
    const summary = idOf(read.text, 'Release summary');
    await call('board_changes');
    await call('board_apply', {
      reason: 'Record what changed',
      ops: [
        {
          op: 'update_node',
          id: summary,
          patch: {
            body: '- "Fix login redirect" is done.\n- "Bump API version" was renamed to "Bump API version to v3".',
          },
        },
      ],
    });
    return 'The summary now lists the two changes.';
  },
};
