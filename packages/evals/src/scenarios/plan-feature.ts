import { edgeBetween, findNodes, isInside, nodes } from '../board.js';
import {
  allExist,
  check,
  edgesExist,
  neverSentCoordinates,
  nodeExists,
  noReversedEdges,
  nothingOutsideFrame,
} from '../checks.js';
import type { Scenario } from '../types.js';
import { node } from './util.js';

const FRAME = /csv export/i;
const QUERY = /query/i;
const ENDPOINT = /endpoint|\bapi\b|route|\bget\b/i;
const BUTTON = /button|download/i;

const DEPENDENCIES = [
  { from: ENDPOINT, to: QUERY, type: 'depends_on' },
  { from: BUTTON, to: ENDPOINT, type: 'depends_on' },
];

export const planFeature: Scenario = {
  id: 'plan-feature',
  title: 'Plan a feature',
  description:
    'Turn a goal into a plan in one batch: tasks with statuses, a decision, a risk and a question in a frame, with dependencies pointing the right way.',
  tags: ['write', 'plan'],
  async setup(ctx) {
    await ctx.apply([
      node('n', 'note', 'Finance request', {
        body: 'Finance wants to download orders as CSV for the monthly close.',
      }),
    ]);
  },
  prompt:
    'Plan CSV export of orders on the board. Put everything in a new frame called "CSV export": tasks (status todo) for the export query, the export endpoint and the download button in the UI; a decision on streaming rows versus building the file in memory; a risk that large exports time out; and a question asking which columns finance needs. The endpoint depends on the query and the button depends on the endpoint. Connect the question to the task it blocks.',
  checks: [
    nodeExists('a "CSV export" frame', FRAME, { type: 'frame' }),
    allExist(
      'three tasks in the frame',
      [QUERY, ENDPOINT, BUTTON].map((pick) => ({ pick, filter: { type: 'task', in: FRAME } })),
      2,
    ),
    check('every task in the frame has status todo', (ctx) => {
      const frames = findNodes(ctx.board, FRAME, { type: 'frame' });
      const tasks = nodes(ctx.board).filter(
        (n) => n.type === 'task' && frames.some((f) => isInside(ctx.board, n, f.id)),
      );
      const bad = tasks.filter((t) => t.status !== 'todo');
      return {
        pass: tasks.length > 0 && bad.length === 0,
        detail: bad.length
          ? `without todo: ${bad.map((t) => t.title).join(', ')}`
          : `${tasks.length} tasks, all todo`,
      };
    }),
    allExist(
      'a decision, a risk and a question in the frame',
      ['decision', 'risk', 'question'].map((type) => ({ pick: /./, filter: { type, in: FRAME } })),
      2,
    ),
    edgesExist('dependencies', DEPENDENCIES, 2),
    noReversedEdges('dependencies point the right way', DEPENDENCIES),
    check('the question blocks a task', (ctx) => {
      const questions = nodes(ctx.board).filter((n) => n.type === 'question');
      const tasks = nodes(ctx.board).filter((n) => n.type === 'task');
      const ok = questions.some((q) =>
        tasks.some((t) => edgeBetween(ctx.board, q.id, t.id, 'blocks')),
      );
      return {
        pass: ok,
        detail: ok ? 'question -blocks-> task' : 'no blocks edge from the question to a task',
      };
    }),
    nothingOutsideFrame('everything new is inside the frame', FRAME),
    check('one batch for the plan', (ctx) => {
      const n = ctx.trace.calls.filter((c) => c.tool === 'board_apply' && !c.isError).length;
      return {
        pass: n === 1,
        score: n === 0 ? 0 : 1 / n,
        detail: `${n} successful board_apply calls`,
      };
    }),
    neverSentCoordinates(),
  ],
  async reference({ call }) {
    await call('board_outline');
    const add = (
      ref: string,
      type: string,
      title: string,
      extra: Record<string, unknown> = {},
    ) => ({
      op: 'add_node',
      ref,
      node: { type, title, parent: '$f', ...extra },
    });
    const link = (type: string, source: string, target: string) => ({
      op: 'add_edge',
      edge: { type, source: `$${source}`, target: `$${target}` },
    });
    await call('board_apply', {
      reason: 'Plan for CSV export',
      ops: [
        { op: 'add_node', ref: 'f', node: { type: 'frame', title: 'CSV export' } },
        add('query', 'task', 'Export query', {
          status: 'todo',
          body: 'Done when: orders for a date range come back in one query.',
        }),
        add('endpoint', 'task', 'Export endpoint', {
          status: 'todo',
          body: 'Done when: GET /api/orders/export returns text/csv.',
        }),
        add('button', 'task', 'Download button', {
          status: 'todo',
          body: 'Done when: the orders page offers the download.',
        }),
        add('d', 'decision', 'Stream rows or build in memory?', {
          body: 'Options: stream from a cursor; build the file in memory.',
        }),
        add('r', 'risk', 'Large exports time out'),
        add('q', 'question', 'Which columns does finance need?'),
        link('depends_on', 'endpoint', 'query'),
        link('depends_on', 'button', 'endpoint'),
        link('blocks', 'q', 'query'),
        link('relates_to', 'd', 'endpoint'),
        link('relates_to', 'r', 'endpoint'),
      ],
    });
    return 'Planned CSV export in the "CSV export" frame.';
  },
};
