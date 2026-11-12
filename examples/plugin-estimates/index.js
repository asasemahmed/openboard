/**
 * An example OpenBoard plugin: effort estimates.
 *
 * - declares the node type `x:estimate` (points, confidence, owner, due date, notes);
 * - adds the template `estimation`;
 * - adds the export format `csv` (one row per estimate);
 * - keeps a note with the running total of points on every board that has estimates.
 *
 * It is a plain ES module that depends on `@openboard/core` for types only.
 * Pass it to a server explicitly:
 *
 *   import { startServer } from '@openboard/server';
 *   import { createEstimatesPlugin } from './examples/plugin-estimates/index.js';
 *   await startServer({ root, plugins: [createEstimatesPlugin()] });
 */

/** @import { Board, BoardApi, Op, OpenBoardPlugin } from '@openboard/core' */

/** The plugin writes the total as this actor; a `system` actor is not held up by the review policy. */
const ACTOR = { id: 'plugin-estimates', kind: 'system', name: 'Estimates' };

/** Marks the note that holds the total, in its props. */
const TOTAL_PROP = 'estimates.total';

/** @param {Board} board */
function estimatesOf(board) {
  return Object.values(board.nodes)
    .filter((node) => node.type === 'x:estimate')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** @param {unknown} value */
function points(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * One CSV cell. Cells that a spreadsheet would run as a formula get a leading
 * apostrophe, since board content is written by anyone who can edit the board.
 * @param {unknown} value
 */
function cell(value) {
  if (value === undefined || value === null) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** @param {Board} board */
function toCsv(board) {
  const header = ['id', 'title', 'status', 'points', 'confidence', 'owner', 'due'];
  const rows = estimatesOf(board).map((node) => {
    const props = node.props ?? {};
    return [
      node.id,
      node.title,
      node.status,
      props.points,
      props.confidence,
      props.owner,
      props.due,
    ].map(cell);
  });
  return `${[header, ...rows].map((row) => row.join(',')).join('\r\n')}\r\n`;
}

/** @returns {Op[]} */
function estimationTemplate(options = {}) {
  /** @type {Op[]} */
  const ops = [
    { op: 'add_node', ref: 'frame', node: { type: 'frame', title: options.title ?? 'Estimation' } },
    {
      op: 'add_node',
      ref: 'scope',
      node: {
        type: 'note',
        title: 'What is being estimated',
        parent: '$frame',
        body: 'Example: the CSV export, from the query to the button on the orders page.',
      },
    },
    {
      op: 'add_node',
      ref: 'query',
      node: {
        type: 'x:estimate',
        title: 'Export query',
        parent: '$frame',
        status: 'todo',
        props: { points: 3, confidence: 'high', owner: 'Ada' },
      },
    },
    {
      op: 'add_node',
      ref: 'endpoint',
      node: {
        type: 'x:estimate',
        title: 'Streaming endpoint',
        parent: '$frame',
        status: 'todo',
        props: {
          points: 5,
          confidence: 'medium',
          notes: 'Assumes the HTTP framework can stream responses.',
        },
      },
    },
    {
      op: 'add_edge',
      edge: { type: 'depends_on', source: '$endpoint', target: '$query' },
    },
    { op: 'add_edge', edge: { type: 'relates_to', source: '$scope', target: '$query' } },
  ];
  return ops;
}

/**
 * A fresh instance of the plugin. Each instance keeps its own session, so one
 * instance per server.
 * @returns {OpenBoardPlugin}
 */
export function createEstimatesPlugin() {
  /** @type {BoardApi | null} */
  let api = null;

  return {
    name: 'estimates',
    version: '1.0.0',
    nodeTypes: {
      'x:estimate': {
        label: 'Estimate',
        description:
          'How much effort a piece of work takes, in points. The total over a board is kept in a note.',
        color: 'teal',
        icon: 'chart',
        hasStatus: true,
        fields: [
          {
            key: 'points',
            label: 'Points',
            kind: 'number',
            required: true,
            description: 'Relative effort; 1 is a few hours.',
          },
          {
            key: 'confidence',
            label: 'Confidence',
            kind: 'select',
            options: ['low', 'medium', 'high'],
          },
          { key: 'owner', label: 'Owner', kind: 'text' },
          { key: 'due', label: 'Due', kind: 'date' },
          { key: 'notes', label: 'Assumptions', kind: 'longtext' },
        ],
      },
    },
    templates: [
      {
        id: 'estimation',
        name: 'Estimation',
        description:
          'Estimate a piece of work in points, part by part, with how sure each estimate is. Use it before committing to a date.',
        tags: ['planning', 'estimates'],
        build: estimationTemplate,
      },
    ],
    exporters: [
      {
        name: 'csv',
        extension: '.csv',
        mime: 'text/csv',
        description: 'the estimates of a board, one row each',
        render: (board) => toCsv(board),
      },
    ],
    setup(ctx) {
      api = ctx.api(ACTOR);
      ctx.log('keeping estimate totals');
      return () => {
        api = null;
      };
    },
    async onBatch({ boardId, batch, board }) {
      // Its own writes come back here too; they never change the total.
      if (!api || batch.actor === ACTOR.id) return;
      const current = board();
      const estimates = estimatesOf(current);
      const note = Object.values(current.nodes).find((node) => node.props?.[TOTAL_PROP] === true);
      if (estimates.length === 0 && !note) return;
      const total = estimates.reduce((sum, node) => sum + points(node.props?.points), 0);
      const title = `Estimate total: ${total} points (${estimates.length} estimate${estimates.length === 1 ? '' : 's'})`;
      if (note?.title === title) return;
      /** @type {Op} */
      const op = note
        ? { op: 'update_node', id: note.id, patch: { title } }
        : {
            op: 'add_node',
            node: {
              type: 'note',
              title,
              body: 'Kept up to date by the estimates plugin: the sum of points over every x:estimate node on this board.',
              props: { [TOTAL_PROP]: true },
            },
          };
      await api.apply(boardId, { ops: [op], reason: 'Update the estimate total' });
    },
  };
}

export default createEstimatesPlugin();
