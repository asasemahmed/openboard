import { describe, expect, it } from 'vitest';
import {
  type Actor,
  absolutePosition,
  ancestorsOf,
  applyOps,
  type Board,
  childrenOf,
  descendantsOf,
  edgesOf,
  emptyBoard,
  type Op,
  selectNodes,
} from './index.js';

const ada: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const T0 = new Date('2026-01-01T00:00:00.000Z');

function build(ops: Op[], board: Board = emptyBoard({ id: 'main', name: 'Main' }, T0)): Board {
  let tick = 0;
  let board2 = board;
  // One op per batch so createdAt differs and ordering by creation time is testable.
  for (const op of ops) {
    const result = applyOps(board2, [op], {
      actor: ada,
      now: new Date(T0.getTime() + ++tick * 1000),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    board2 = result.board;
  }
  return board2;
}

/**
 * plan (frame, 0,0)
 *   notes (note, 0,100)  "Design notes"
 *   sprint (frame, 0,300)
 *     parser (task, 0,100) in_progress [core, parser]
 *     lexer  (task, 0,0)   done        [core]
 * q (question, no position)  "Open question"
 * r (risk, no position)
 * edges: parser -depends_on-> lexer, q -relates_to-> parser, r -blocks-> q
 */
const board = build([
  { op: 'add_node', id: 'plan', node: { type: 'frame', title: 'Plan', view: { x: 0, y: 0 } } },
  { op: 'add_node', id: 'q', node: { type: 'question', title: 'Open question' } },
  { op: 'add_node', id: 'r', node: { type: 'risk', title: 'Risk', status: 'todo' } },
  {
    op: 'add_node',
    id: 'sprint',
    node: { type: 'frame', title: 'Sprint', parent: 'plan', view: { x: 0, y: 300 } },
  },
  {
    op: 'add_node',
    id: 'parser',
    node: {
      type: 'task',
      title: 'Write parser',
      parent: 'sprint',
      status: 'in_progress',
      tags: ['core', 'parser'],
      body: 'Parse the BOARD file',
      view: { x: 0, y: 100 },
    },
  },
  {
    op: 'add_node',
    id: 'lexer',
    node: {
      type: 'task',
      title: 'Lexer',
      parent: 'sprint',
      status: 'done',
      tags: ['core'],
      view: { x: 0, y: 0 },
    },
  },
  {
    op: 'add_node',
    id: 'notes',
    node: { type: 'note', title: 'Design notes', parent: 'plan', view: { x: 0, y: 100 } },
  },
  { op: 'add_edge', id: 'e1', edge: { type: 'depends_on', source: 'parser', target: 'lexer' } },
  { op: 'add_edge', id: 'e2', edge: { type: 'relates_to', source: 'q', target: 'parser' } },
  { op: 'add_edge', id: 'e3', edge: { type: 'blocks', source: 'r', target: 'q' } },
]);

const ids = (nodes: { id: string }[]) => nodes.map((node) => node.id);

describe('graph helpers', () => {
  it('walks frames', () => {
    expect(ids(childrenOf(board, 'plan'))).toEqual(['notes', 'sprint']);
    expect(ids(descendantsOf(board, 'plan'))).toEqual(['notes', 'sprint', 'lexer', 'parser']);
    expect(ids(ancestorsOf(board, 'parser'))).toEqual(['sprint', 'plan']);
    expect(ids(edgesOf(board, 'parser'))).toEqual(['e1', 'e2']);
    expect(absolutePosition(board, 'parser')).toEqual({ x: 0, y: 400 });
    expect(absolutePosition(board, 'q')).toBeUndefined();
  });
});

describe('selectNodes', () => {
  it('returns the whole board in presentation order without filters', () => {
    // Positioned nodes first in reading order, frames before their contents,
    // then unpositioned nodes by creation time.
    expect(ids(selectNodes(board, {}))).toEqual([
      'plan',
      'notes',
      'sprint',
      'lexer',
      'parser',
      'q',
      'r',
    ]);
  });

  it('filters by ids', () => {
    expect(ids(selectNodes(board, { ids: ['r', 'lexer', 'nope'] }))).toEqual(['lexer', 'r']);
  });

  it('filters by frame, recursively, excluding the frame itself', () => {
    expect(ids(selectNodes(board, { frame: 'plan' }))).toEqual([
      'notes',
      'sprint',
      'lexer',
      'parser',
    ]);
    expect(ids(selectNodes(board, { frame: 'sprint' }))).toEqual(['lexer', 'parser']);
    expect(selectNodes(board, { frame: 'missing' })).toEqual([]);
  });

  it('filters by selection', () => {
    expect(
      ids(selectNodes(board, { selection: true }, { selection: { nodeIds: ['q', 'notes'] } })),
    ).toEqual(['notes', 'q']);
    expect(selectNodes(board, { selection: true })).toEqual([]);
  });

  it('filters by types, statuses, tags and text', () => {
    expect(ids(selectNodes(board, { types: ['task', 'risk'] }))).toEqual(['lexer', 'parser', 'r']);
    expect(ids(selectNodes(board, { statuses: ['done', 'todo'] }))).toEqual(['lexer', 'r']);
    expect(ids(selectNodes(board, { tags: ['core'] }))).toEqual(['lexer', 'parser']);
    expect(ids(selectNodes(board, { tags: ['core', 'parser'] }))).toEqual(['parser']);
    expect(ids(selectNodes(board, { text: 'board' }))).toEqual(['parser']);
    expect(ids(selectNodes(board, { text: 'NOTES' }))).toEqual(['notes']);
  });

  it('combines filters with AND', () => {
    expect(ids(selectNodes(board, { frame: 'plan', tags: ['core'], statuses: ['done'] }))).toEqual([
      'lexer',
    ]);
    expect(selectNodes(board, { types: ['note'], tags: ['core'] })).toEqual([]);
  });

  it('expands to neighbours after filtering, in both directions', () => {
    expect(ids(selectNodes(board, { ids: ['parser'], neighbors: 1 }))).toEqual([
      'lexer',
      'parser',
      'q',
    ]);
    expect(ids(selectNodes(board, { ids: ['parser'], neighbors: 2 }))).toEqual([
      'lexer',
      'parser',
      'q',
      'r',
    ]);
    expect(ids(selectNodes(board, { types: ['risk'], neighbors: 1 }))).toEqual(['q', 'r']);
  });
});
