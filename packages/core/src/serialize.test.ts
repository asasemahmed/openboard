import { describe, expect, it } from 'vitest';
import {
  type Actor,
  applyOps,
  type Board,
  diffBoards,
  emptyBoard,
  type Op,
  OpenBoardError,
  parseBoard,
  serializeBoard,
  validateBoard,
} from './index.js';

const ada: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-02T00:00:00.000Z');

function counter() {
  let i = 0;
  return (prefix: string) => `${prefix}_${++i}`;
}

function build(ops: Op[]): Board {
  const result = applyOps(emptyBoard({ id: 'main', name: 'Main' }, T0), ops, {
    actor: ada,
    now: T1,
    newId: counter(),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.board;
}

const ops: Op[] = [
  { op: 'add_node', ref: 'f', node: { type: 'frame', title: 'Frame', view: { x: 0, y: 0 } } },
  {
    op: 'add_node',
    ref: 'a',
    node: {
      type: 'task',
      title: 'A',
      parent: '$f',
      status: 'todo',
      tags: ['b', 'a'],
      body: 'line one\nline two',
      props: { zeta: 1, alpha: { y: true, b: [3, 1] } },
      links: [{ kind: 'file', target: 'src/a.ts', line: 3 }],
      view: { x: 10, y: 20 },
    },
  },
  { op: 'add_node', ref: 'b', node: { type: 'note', title: 'B' } },
  { op: 'add_edge', edge: { type: 'depends_on', source: '$a', target: '$b', label: 'needs' } },
];

describe('serializeBoard / parseBoard', () => {
  it('round-trips', () => {
    const board = build(ops);
    expect(parseBoard(serializeBoard(board))).toEqual(board);
  });

  it('is byte-identical regardless of insertion order', () => {
    const board = build(ops);
    const shuffled: Board = {
      ...board,
      nodes: Object.fromEntries(Object.entries(board.nodes).reverse()),
      edges: Object.fromEntries(Object.entries(board.edges).reverse()),
    };
    const node = shuffled.nodes.n_2;
    if (!node?.props) throw new Error('fixture');
    shuffled.nodes.n_2 = {
      ...node,
      props: Object.fromEntries(Object.entries(node.props).reverse()),
    };
    expect(serializeBoard(shuffled)).toBe(serializeBoard(board));
  });

  it('writes a fixed layout: sorted ids, ordered fields, sorted props, trailing newline', () => {
    const text = serializeBoard(build(ops));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.indexOf('"n_1"')).toBeLessThan(text.indexOf('"n_2"'));
    const node = text.slice(text.indexOf('"n_2": {'));
    const order = [
      '"id"',
      '"type"',
      '"title"',
      '"status"',
      '"parent"',
      '"tags"',
      '"body"',
      '"links"',
      '"props"',
      '"view"',
      '"createdBy"',
      '"updatedAt"',
    ];
    const positions = order.map((key) => node.indexOf(key));
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    expect(node.indexOf('"alpha"')).toBeLessThan(node.indexOf('"zeta"'));
    expect(node.indexOf('"b": [')).toBeLessThan(node.indexOf('"y": true'));
  });

  it('turns a one-field change into a one-line diff', () => {
    const board = build(ops);
    const changed = structuredClone(board);
    if (!changed.nodes.n_2) throw new Error('fixture');
    changed.nodes.n_2.status = 'done';
    const before = serializeBoard(board).split('\n');
    const after = serializeBoard(changed).split('\n');
    expect(after).toHaveLength(before.length);
    const differing = before.filter((line, i) => line !== after[i]);
    expect(differing).toEqual(['      "status": "todo",']);
  });

  it('leaves out empty optional fields', () => {
    const board = build([
      {
        op: 'add_node',
        id: 'x',
        node: { type: 'note', title: 'X', tags: [], props: {}, body: '' },
      },
    ]);
    const text = serializeBoard(board);
    expect(text).not.toContain('"tags"');
    expect(text).not.toContain('"props"');
    expect(text).not.toContain('"body"');
    expect(text).not.toContain('"description"');
  });

  it('rejects invalid JSON and names the path of a schema failure', () => {
    expect(() => parseBoard('{')).toThrow(OpenBoardError);
    const board = JSON.parse(serializeBoard(build(ops)));
    board.nodes.n_2.title = '';
    let caught: unknown;
    try {
      parseBoard(JSON.stringify(board));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenBoardError);
    expect((caught as OpenBoardError).code).toBe('invalid_request');
    expect((caught as Error).message).toContain('nodes.n_2.title');
  });

  it('rejects boards that break the semantic rules', () => {
    const board = JSON.parse(serializeBoard(build(ops)));
    board.edges.e_4.target = 'ghost';
    expect(() => parseBoard(JSON.stringify(board))).toThrow(/edges\.e_4\.target/);
    expect(validateBoard(parseBoard(serializeBoard(build(ops))))).toEqual([]);
  });
});

describe('diffBoards', () => {
  it('separates moves from semantic updates', () => {
    const before = build(ops);
    const after = structuredClone(before);
    const a = after.nodes.n_2;
    const b = after.nodes.n_3;
    if (!a || !b) throw new Error('fixture');
    a.view = { x: 99, y: 20 };
    b.title = 'B2';
    b.view = { x: 1, y: 1 };
    delete after.edges.e_4;
    after.nodes.n_9 = { ...b, id: 'n_9' };

    const diff = diffBoards(before, after);
    expect(diff.isEmpty).toBe(false);
    expect(diff.nodes.added.map((n) => n.id)).toEqual(['n_9']);
    expect(diff.nodes.updated.map((u) => [u.id, u.fields])).toEqual([['n_3', ['title']]]);
    expect(diff.nodes.moved.map((m) => m.id)).toEqual(['n_2', 'n_3']);
    expect(diff.nodes.moved[0]).toMatchObject({
      before: { x: 10, y: 20 },
      after: { x: 99, y: 20 },
    });
    expect(diff.edges.removed.map((e) => e.id)).toEqual(['e_4']);
  });

  it('is empty for equal boards', () => {
    const board = build(ops);
    expect(diffBoards(board, structuredClone(board)).isEmpty).toBe(true);
  });
});
