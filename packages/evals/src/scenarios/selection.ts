import { edges, findNodes, isInside, nodes } from '../board.js';
import {
  check,
  neverSentCoordinates,
  noDuplicates,
  nodeExists,
  nodesUnchanged,
  selectionBeforeActing,
} from '../checks.js';
import { nodesInText } from '../reference.js';
import type { Scenario } from '../types.js';
import { frame, keep, task } from './util.js';

const SELECTED = ['rate', 'lock', 'alert'] as const;
const OTHERS = ['dark', 'pdf', 'keys'] as const;
const FRAME = /login hardening/i;

export const selectionAsContext: Scenario = {
  id: 'selection-as-context',
  title: 'Selection as context',
  description:
    'The person has three cards selected and says "these": the agent must read the selection, group exactly those nodes in a new frame, and add a risk about them.',
  tags: ['selection', 'write'],
  async setup(ctx) {
    await ctx.setPolicy('auto');
    const refs = await ctx.apply([
      frame('backlog', 'Backlog'),
      task('rate', 'Rate limit login attempts', '$backlog'),
      task('lock', 'Lock account after failed logins', '$backlog'),
      task('alert', 'Alert on brute-force attempts', '$backlog'),
      task('dark', 'Dark mode', '$backlog'),
      task('pdf', 'Export to PDF', '$backlog'),
      task('keys', 'Keyboard shortcuts', '$backlog'),
    ]);
    keep(ctx.ids, refs, ['backlog', ...SELECTED, ...OTHERS]);
  },
  human: { select: SELECTED.map((key) => ({ key })) },
  prompt: 'Turn these into a frame called "Login hardening" and add a risk about them.',
  checks: [
    nodeExists('a "Login hardening" frame', FRAME, { type: 'frame' }),
    check(
      'exactly the selected nodes are in it',
      (ctx) => {
        const frames = findNodes(ctx.board, FRAME, { type: 'frame' });
        const inside = (id: string | undefined) => {
          const n = id ? ctx.board.nodes[id] : undefined;
          return n !== undefined && frames.some((f) => isInside(ctx.board, n, f.id));
        };
        const missing = SELECTED.filter((key) => !inside(ctx.ids[key]));
        const extra = OTHERS.filter((key) => inside(ctx.ids[key]));
        const wrong = missing.length + extra.length;
        return {
          pass: wrong === 0,
          score: 1 - wrong / (SELECTED.length + OTHERS.length),
          detail:
            wrong === 0
              ? 'the three selected tasks, and only those'
              : `missing ${missing.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'}`,
        };
      },
      2,
    ),
    nodesUnchanged(
      'the other backlog tasks are untouched',
      OTHERS.map((key) => ({ key })),
    ),
    check('a risk about them', (ctx) => {
      const frames = findNodes(ctx.board, FRAME, { type: 'frame' });
      const selected = new Set(SELECTED.map((key) => ctx.ids[key]));
      const risks = nodes(ctx.board).filter((n) => n.type === 'risk' && !ctx.initial.nodes[n.id]);
      const ok = risks.some(
        (r) =>
          frames.some((f) => isInside(ctx.board, r, f.id)) ||
          edges(ctx.board).some(
            (e) =>
              (e.source === r.id && selected.has(e.target)) ||
              (e.target === r.id && selected.has(e.source)),
          ),
      );
      return {
        pass: ok,
        detail: ok
          ? 'risk added in the frame or linked to the tasks'
          : `${risks.length} new risks, none in the frame or linked`,
      };
    }),
    selectionBeforeActing(2),
    neverSentCoordinates(),
    noDuplicates('did not re-create the selected tasks'),
  ],
  async reference({ call }) {
    const selection = await call('board_selection');
    const tasks = nodesInText(selection.text).map((n) => n.id);
    await call('board_apply', {
      reason: 'Group the login hardening work',
      ops: [
        { op: 'add_node', ref: 'f', node: { type: 'frame', title: 'Login hardening' } },
        ...tasks.map((id) => ({ op: 'update_node', id, patch: { parent: '$f' } })),
        {
          op: 'add_node',
          ref: 'r',
          node: {
            type: 'risk',
            title: 'Lockouts can be abused',
            parent: '$f',
            body: 'Locking accounts after failures lets an attacker lock out real users; pair it with rate limits and alerts.',
          },
        },
      ],
    });
    return 'Grouped the three selected tasks in "Login hardening" and added a risk.';
  },
};
