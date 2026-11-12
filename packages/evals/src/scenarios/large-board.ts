import type { Op, Status } from '@openboard/core';
import { nodes, semantic } from '../board.js';
import { check, statusEquals, targetedReads, withinBudget } from '../checks.js';
import { pick, seededRandom } from '../random.js';
import { idOf } from '../reference.js';
import type { Scenario } from '../types.js';

const AREAS = [
  'Accounts',
  'Billing',
  'Search',
  'Notifications',
  'Reporting',
  'Mobile',
  'Admin',
  'Infrastructure',
  'Onboarding',
  'Integrations',
];
const VERBS = [
  'Add',
  'Fix',
  'Refactor',
  'Document',
  'Test',
  'Migrate',
  'Speed up',
  'Remove',
  'Audit',
  'Localize',
];
const NOUNS = [
  'invoice filters',
  'profile page',
  'order history',
  'webhook retries',
  'search ranking',
  'push settings',
  'CSV import',
  'audit log',
  'team roles',
  'usage charts',
  'tax rules',
  'API tokens',
  'sync worker',
  'billing emails',
  'session timeout',
  'image uploads',
  'rate limits',
  'feature flags',
  'error pages',
  'admin search',
  'data export',
  'cache warmup',
  'sitemap',
  'trial banner',
  'refund flow',
  'status page',
  'mobile menu',
  'dark theme',
  'date pickers',
  'saved views',
];
const QUALIFIERS = [
  'for teams',
  'on mobile',
  'in the admin',
  'for enterprise',
  'v2',
  'for EU customers',
  'in reports',
  'behind a flag',
];
const FILLER =
  'Context: raised in planning; see the area owner for details. Acceptance: covered by tests, reviewed, documented in the changelog, and rolled out behind the usual checks.';

/** 10 frames x 50 nodes: 49 generated tasks and one note each, plus the target and two distractors. */
export function largeBoardOps(seed = 42): { batches: Op[][] } {
  const random = seededRandom(seed);
  const titles = new Set<string>();
  const batches: Op[][] = [];
  const statuses: Status[] = ['todo', 'todo', 'in_progress', 'done', 'blocked'];
  for (const [a, area] of AREAS.entries()) {
    const ops: Op[] = [{ op: 'add_node', ref: 'f', node: { type: 'frame', title: area } }];
    for (let i = 0; i < 48; i++) {
      let title = '';
      do title = `${pick(random, VERBS)} ${pick(random, NOUNS)} ${pick(random, QUALIFIERS)}`;
      while (titles.has(title));
      titles.add(title);
      ops.push({
        op: 'add_node',
        ref: `t${i}`,
        node: {
          type: 'task',
          title,
          status: pick(random, statuses),
          parent: '$f',
          body: `Done when: ${title.toLowerCase()} works end to end. ${FILLER}`,
        },
      });
      if (i > 0 && random() < 0.3) {
        ops.push({
          op: 'add_edge',
          edge: { type: 'depends_on', source: `$t${i}`, target: `$t${Math.floor(random() * i)}` },
        });
      }
    }
    ops.push({
      op: 'add_node',
      ref: 'note',
      node: {
        type: 'note',
        title: `${area} owners`,
        parent: '$f',
        body: `Who to ask about ${area.toLowerCase()} work. ${FILLER}`,
      },
    });
    if (a === 0) {
      ops.push(
        {
          op: 'add_node',
          ref: 'target',
          node: {
            type: 'task',
            title: 'Password reset email',
            status: 'in_progress',
            parent: '$f',
            body: `Done when: a reset link arrives within a minute and expires after an hour. ${FILLER}`,
          },
        },
        {
          op: 'add_node',
          ref: 'distractorNote',
          node: {
            type: 'note',
            title: 'Mail provider',
            parent: '$f',
            body: 'Password reset emails go through the mail provider; ask ops for access.',
          },
        },
      );
    }
    if (a === 7) {
      ops.push({
        op: 'add_node',
        ref: 'distractorTask',
        node: {
          type: 'task',
          title: 'Reset staging database',
          status: 'todo',
          parent: '$f',
          body: `Nightly. ${FILLER}`,
        },
      });
    }
    batches.push(ops);
  }
  return { batches };
}

export const findAndUpdateOnLargeBoard: Scenario = {
  id: 'find-and-update-on-large-board',
  title: 'Find and update one node on a large board',
  description:
    'A 500-node board; mark one task done. Success needs the right node only; the score falls as the agent reads more of the board.',
  tags: ['read', 'budget', 'large'],
  async setup(ctx) {
    // The agent planned all of this in an earlier session, so changing it needs no review.
    for (const ops of largeBoardOps().batches) {
      const refs = await ctx.apply(ops, { as: ctx.agent });
      for (const key of ['target', 'distractorNote', 'distractorTask']) {
        if (refs[key]) ctx.ids[key] = refs[key];
      }
    }
    // What reading everything costs: every frame, at the default detail.
    let full = 0;
    const board = await ctx.owner.getBoard(ctx.board);
    for (const frame of nodes(board).filter((n) => n.type === 'frame')) {
      full += (await ctx.owner.read(ctx.board, { frame: frame.id, maxTokens: 50_000 })).tokens;
    }
    ctx.metrics.fullReadTokens = full;
  },
  prompt: 'Mark the task about password reset as done.',
  checks: [
    statusEquals('the password reset task is done', { key: 'target' }, 'done', 3),
    check(
      'nothing else changed',
      (ctx) => {
        const changed = nodes(ctx.initial).filter((n) => {
          if (n.id === ctx.ids.target) return false;
          const now = ctx.board.nodes[n.id];
          return !now || semantic(now) !== semantic(n);
        });
        const added = nodes(ctx.board).filter((n) => !ctx.initial.nodes[n.id]);
        const bad = [
          ...changed.map((n) => `changed ${n.title}`),
          ...added.map((n) => `added ${n.title}`),
        ];
        return {
          pass: bad.length === 0,
          detail: bad.length ? bad.slice(0, 5).join(', ') : 'only the target changed',
        };
      },
      2,
    ),
    targetedReads({ goodFraction: 0.05, badFraction: 0.5 }, 2),
    withinBudget({ maxToolCalls: 6, maxBoardTokens: 3000 }),
  ],
  budget: { maxToolCalls: 6, maxBoardTokens: 3000 },
  async reference({ call }) {
    await call('board_outline');
    const found = await call('board_read', {
      text: 'password reset',
      types: ['task'],
      detail: 'titles',
    });
    const id = idOf(found.text, 'Password reset email');
    await call('board_apply', {
      reason: 'Password reset email is done',
      ops: [{ op: 'update_node', id, patch: { status: 'done' } }],
    });
    return 'Marked "Password reset email" as done.';
  },
};
