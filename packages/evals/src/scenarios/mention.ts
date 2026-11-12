import { calledTool, checkedInbox, nodeExists } from '../checks.js';
import { AGENT_ID } from '../harness.js';
import { idOf } from '../reference.js';
import type { Scenario } from '../types.js';
import { frame, keep, task } from './util.js';

export const noticeMidRunMention: Scenario = {
  id: 'notice-mid-run-mention',
  title: 'Notice a mention mid-run',
  description:
    'While the agent works, the person mentions it in a comment with an extra request. The agent learns of it from the notice line, reads its inbox, does it, and replies in the thread.',
  tags: ['inbox', 'comments'],
  async setup(ctx) {
    const refs = await ctx.apply([frame('ops', 'Ops'), task('keys', 'Rotate API keys', '$ops')]);
    keep(ctx.ids, refs, ['ops', 'keys']);
  },
  human: {
    events: [
      {
        name: 'mentions the agent',
        at: { afterCalls: 1 },
        action: {
          kind: 'comment',
          on: { key: 'ops' },
          body: 'While you are in Ops: please also add a risk about missing rollback steps.',
          mentions: [AGENT_ID],
        },
      },
    ],
  },
  prompt: 'Add a note "Deploy checklist" to the Ops frame.',
  checks: [
    nodeExists('the note is in Ops', /deploy checklist/i, { type: 'note', in: { key: 'ops' } }),
    checkedInbox('read the inbox after the mention', (call) => call.seq === 1, 2),
    nodeExists('did what the comment asked', /rollback/i, { type: 'risk', in: { key: 'ops' } }, 2),
    calledTool('replied in the thread', 'board_comment', {
      args: (a) => typeof a.thread === 'string',
    }),
  ],
  async reference({ call }) {
    const outline = await call('board_outline');
    const ops = idOf(outline.text, 'Ops');
    await call('board_apply', {
      reason: 'Deploy checklist',
      ops: [{ op: 'add_node', node: { type: 'note', title: 'Deploy checklist', parent: ops } }],
    });
    const inbox = await call('board_inbox');
    const thread = /thread (c_[A-Za-z0-9]+)/.exec(inbox.text)?.[1];
    if (!thread) throw new Error(`no thread in the inbox:\n${inbox.text}`);
    await call('board_apply', {
      reason: 'Risk asked for in a comment',
      ops: [
        { op: 'add_node', node: { type: 'risk', title: 'Missing rollback steps', parent: ops } },
      ],
    });
    await call('board_comment', {
      thread,
      body: 'Added the risk "Missing rollback steps" to Ops.',
    });
    return 'Added the deploy checklist and, as asked in a comment, a risk about rollback steps.';
  },
};
