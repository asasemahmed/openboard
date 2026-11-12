import { describe, expect, it } from 'vitest';
import { type Actor, applyOps, type Board, emptyBoard, type Op, type OpError } from './index.js';

const ada: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const bot: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };
const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-02T00:00:00.000Z');
const T2 = new Date('2026-01-03T00:00:00.000Z');

function counter() {
  let i = 0;
  return (prefix: string) => `${prefix}_${++i}`;
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function run(board: Board, ops: unknown[], actor: Actor = ada, now: Date = T1) {
  return applyOps(board, ops as Op[], { actor, now, newId: counter() });
}

function ok(board: Board, ops: unknown[], actor: Actor = ada, now: Date = T1) {
  const result = run(board, ops, actor, now);
  if (!result.ok) throw new Error(`expected success: ${JSON.stringify(result.errors)}`);
  return result;
}

function errors(board: Board, ops: unknown[]): OpError[] {
  const result = run(board, ops);
  if (result.ok) throw new Error('expected failure');
  return result.errors;
}

/** A board with a frame `f` at (100, 50) holding task `t` at (10, 20), and a root note `n`. */
function seeded(): Board {
  return ok(emptyBoard({ id: 'main', name: 'Main' }, T0), [
    { op: 'add_node', id: 'f', node: { type: 'frame', title: 'Frame', view: { x: 100, y: 50 } } },
    {
      op: 'add_node',
      id: 't',
      node: { type: 'task', title: 'Task', parent: 'f', view: { x: 10, y: 20 } },
    },
    { op: 'add_node', id: 'n', node: { type: 'note', title: 'Note', body: 'hello' } },
  ]).board;
}

describe('applyOps: success', () => {
  it('creates a connected structure through $ref chains', () => {
    const board = emptyBoard({ id: 'main', name: 'Main' }, T0);
    const result = ok(board, [
      { op: 'add_node', ref: 'goal', node: { type: 'frame', title: 'Goal' } },
      { op: 'add_node', ref: 'a', node: { type: 'task', title: 'A', parent: '$goal' } },
      { op: 'add_node', ref: 'b', node: { type: 'task', title: 'B', parent: '$goal' } },
      { op: 'add_edge', edge: { type: 'depends_on', source: '$b', target: '$a' } },
      { op: 'update_node', id: '$a', patch: { status: 'todo' } },
    ]);
    const { refs } = result.applied;
    expect(refs).toEqual({ goal: 'n_1', a: 'n_2', b: 'n_3' });
    expect(result.board.nodes.n_2).toMatchObject({ parent: 'n_1', status: 'todo' });
    expect(result.board.edges.e_4).toMatchObject({ source: 'n_3', target: 'n_2' });
    expect(result.applied.addedNodes).toEqual(['n_1', 'n_2', 'n_3']);
    expect(result.applied.addedEdges).toEqual(['e_4']);
    expect(result.applied.updatedNodes).toEqual([]);
  });

  it('records bookkeeping, registers the actor and bumps board.updatedAt', () => {
    const result = ok(emptyBoard({ id: 'main', name: 'Main' }, T0), [
      { op: 'add_node', id: 'x', node: { type: 'note', title: 'X' } },
    ]);
    expect(result.board.nodes.x).toMatchObject({
      createdBy: 'ada',
      createdAt: T1.toISOString(),
      updatedBy: 'ada',
      updatedAt: T1.toISOString(),
    });
    expect(result.board.actors).toEqual({ ada });
    expect(result.board.updatedAt).toBe(T1.toISOString());
  });

  it('never mutates the input board', () => {
    const board = freeze(seeded());
    const snapshot = structuredClone(board);
    ok(board, [
      { op: 'update_node', id: 't', patch: { title: 'Renamed', tags: ['a'] } },
      { op: 'move_node', id: 'n', view: { x: 1, y: 2 } },
      { op: 'remove_node', id: 'f' },
    ]);
    expect(board).toEqual(snapshot);
  });

  it('lets each op see the effect of the ops before it', () => {
    const result = ok(seeded(), [
      { op: 'add_node', id: 'g', node: { type: 'frame', title: 'G' } },
      { op: 'update_node', id: 'n', patch: { parent: 'g' } },
      { op: 'remove_node', id: 't' },
      { op: 'add_node', id: 't', node: { type: 'question', title: 'Again' } },
    ]);
    expect(result.board.nodes.n?.parent).toBe('g');
    expect(result.board.nodes.t?.type).toBe('question');
    expect(result.applied.updatedNodes).toEqual(['n', 't']);
  });

  it('treats a patch that changes nothing as a no-op', () => {
    const board = seeded();
    const result = ok(
      board,
      [{ op: 'update_node', id: 't', patch: { title: 'Task', parent: 'f' } }],
      bot,
      T2,
    );
    expect(result.applied.updatedNodes).toEqual([]);
    expect(result.board).toEqual(board);
    expect(result.board.actors.bot).toBeUndefined();
  });

  it('clears a field set to null', () => {
    const result = ok(seeded(), [{ op: 'update_node', id: 'n', patch: { body: null } }]);
    expect(result.board.nodes.n?.body).toBeUndefined();
    expect('body' in (result.board.nodes.n ?? {})).toBe(false);
  });

  it('leaves updatedBy, updatedAt and board.updatedAt alone on a move', () => {
    const board = seeded();
    const result = ok(
      board,
      [{ op: 'move_node', id: 't', view: { x: 99, pinned: true } }],
      bot,
      T2,
    );
    const node = result.board.nodes.t;
    expect(node?.view).toEqual({ x: 99, y: 20, pinned: true });
    expect(node?.updatedBy).toBe('ada');
    expect(node?.updatedAt).toBe(T1.toISOString());
    expect(result.board.updatedAt).toBe(board.updatedAt);
    expect(result.board.actors.bot).toBeUndefined();
    expect(result.applied.updatedNodes).toEqual(['t']);
  });

  it('clears the position of a node moved to another frame, unless the batch places it', () => {
    const board = ok(seeded(), [
      { op: 'add_node', id: 'g', node: { type: 'frame', title: 'G', view: { x: 0, y: 0 } } },
    ]).board;
    const cleared = ok(board, [{ op: 'update_node', id: 't', patch: { parent: 'g' } }]);
    expect(cleared.board.nodes.t?.view).toBeUndefined();

    const placed = ok(board, [
      { op: 'move_node', id: 't', view: { x: 5, y: 6 } },
      { op: 'update_node', id: 't', patch: { parent: 'g' } },
    ]);
    expect(placed.board.nodes.t?.view).toEqual({ x: 5, y: 6 });
  });

  it('reparents the children of a removed frame and converts their coordinates', () => {
    const board = ok(seeded(), [
      {
        op: 'add_node',
        id: 'outer',
        node: { type: 'frame', title: 'Outer', view: { x: 0, y: 0 } },
      },
      { op: 'update_node', id: 'f', patch: { parent: 'outer' } },
      { op: 'move_node', id: 'f', view: { x: 100, y: 50 } },
    ]).board;
    const result = ok(board, [{ op: 'remove_node', id: 'f' }], bot, T2);
    expect(result.board.nodes.f).toBeUndefined();
    expect(result.board.nodes.t).toMatchObject({
      parent: 'outer',
      view: { x: 110, y: 70 },
      updatedBy: 'bot',
    });
    expect(result.applied).toMatchObject({ removedNodes: ['f'], updatedNodes: ['t'] });
  });

  it('moves children of a removed root frame to the canvas', () => {
    const result = ok(seeded(), [{ op: 'remove_node', id: 'f', children: 'reparent' }]);
    expect(result.board.nodes.t?.parent).toBeUndefined();
    expect(result.board.nodes.t?.view).toEqual({ x: 110, y: 70 });
  });

  it('removes a frame with everything inside it on cascade', () => {
    const board = ok(seeded(), [
      { op: 'add_node', id: 'inner', node: { type: 'frame', title: 'Inner', parent: 'f' } },
      { op: 'add_node', id: 'deep', node: { type: 'note', title: 'Deep', parent: 'inner' } },
      { op: 'add_edge', id: 'e1', edge: { type: 'relates_to', source: 'deep', target: 'n' } },
    ]).board;
    const result = ok(board, [{ op: 'remove_node', id: 'f', children: 'cascade' }]);
    expect(Object.keys(result.board.nodes)).toEqual(['n']);
    expect(result.board.edges).toEqual({});
    expect(result.applied.removedNodes.sort()).toEqual(['deep', 'f', 'inner', 't']);
    expect(result.applied.removedEdges).toEqual(['e1']);
  });

  it('removes the edges touching a removed node', () => {
    const board = ok(seeded(), [
      { op: 'add_edge', id: 'e1', edge: { type: 'relates_to', source: 't', target: 'n' } },
    ]).board;
    const result = ok(board, [
      { op: 'remove_node', id: 'n' },
      { op: 'remove_edge', id: 'e1' },
    ]);
    expect(result.board.edges).toEqual({});
    expect(result.applied.removedEdges).toEqual(['e1']);
  });

  it('updates and clears edge labels', () => {
    const board = ok(seeded(), [
      {
        op: 'add_edge',
        id: 'e1',
        edge: { type: 'relates_to', source: 't', target: 'n', label: 'x' },
      },
    ]).board;
    const changed = ok(board, [
      { op: 'update_edge', id: 'e1', patch: { type: 'blocks', label: null } },
    ]);
    expect(changed.board.edges.e1).toMatchObject({ type: 'blocks' });
    expect(changed.board.edges.e1?.label).toBeUndefined();
    expect(changed.applied.updatedEdges).toEqual(['e1']);
  });
});

describe('applyOps: errors', () => {
  it('invalid: schema violations name the failing path', () => {
    const [error] = errors(seeded(), [{ op: 'update_node', id: 't', patch: { title: '' } }]);
    expect(error).toMatchObject({ index: 0, code: 'invalid' });
    expect(error?.message).toContain('patch.title');
  });

  it('invalid: unknown op kinds and misplaced fields are reported, not ignored', () => {
    const found = errors(seeded(), [
      { op: 'explode', id: 't' },
      { op: 'update_node', id: 't', patch: { view: { x: 1, y: 1 } } },
      { op: 'move_node', id: 'n', view: { y: 3 } },
    ]);
    expect(found.map((e) => [e.index, e.code])).toEqual([
      [0, 'invalid'],
      [1, 'invalid'],
      [2, 'invalid'],
    ]);
    expect(found[0]?.message).toContain('add_node');
    expect(found[1]?.message).toContain('move_node');
    expect(found[2]?.message).toContain('"x" and "y"');
  });

  it('not_found: missing nodes and edges', () => {
    const found = errors(seeded(), [
      { op: 'update_node', id: 'nope', patch: { title: 'x' } },
      { op: 'remove_edge', id: 'e_nope' },
      { op: 'remove_node', id: 'n' },
      { op: 'move_node', id: 'n', view: { x: 1, y: 1 } },
    ]);
    expect(found.map((e) => [e.index, e.code])).toEqual([
      [0, 'not_found'],
      [1, 'not_found'],
      [3, 'not_found'],
    ]);
    expect(found[2]?.message).toContain('removed by op 2');
  });

  it('duplicate_id: an id already used by a node or edge', () => {
    const board = ok(seeded(), [
      { op: 'add_edge', id: 'e1', edge: { type: 'relates_to', source: 't', target: 'n' } },
    ]).board;
    const found = errors(board, [
      { op: 'add_node', id: 't', node: { type: 'note', title: 'Dup' } },
      { op: 'add_node', id: 'e1', node: { type: 'note', title: 'Dup' } },
    ]);
    expect(found.map((e) => e.code)).toEqual(['duplicate_id', 'duplicate_id']);
  });

  it('unknown_ref: undeclared refs, and refs used before their declaration', () => {
    const found = errors(seeded(), [
      { op: 'update_node', id: '$ghost', patch: { title: 'x' } },
      { op: 'add_edge', edge: { type: 'relates_to', source: '$later', target: 'n' } },
      { op: 'add_node', ref: 'later', node: { type: 'note', title: 'Later' } },
    ]);
    expect(found.map((e) => [e.index, e.code])).toEqual([
      [0, 'unknown_ref'],
      [1, 'unknown_ref'],
    ]);
    expect(found[1]?.message).toContain('declared later, by op 2');
  });

  it('duplicate_ref: one ref declared twice', () => {
    const found = errors(seeded(), [
      { op: 'add_node', ref: 'a', node: { type: 'note', title: 'A' } },
      { op: 'add_node', ref: 'a', node: { type: 'note', title: 'B' } },
    ]);
    expect(found).toEqual([expect.objectContaining({ index: 1, code: 'duplicate_ref' })]);
  });

  it('not_a_frame: a parent that is not a frame', () => {
    const [error] = errors(seeded(), [
      { op: 'add_node', node: { type: 'note', title: 'Child', parent: 'n' } },
    ]);
    expect(error?.code).toBe('not_a_frame');
    expect(error?.message).toBe(
      'parent "n" is a note ("Note"), not a frame; only frames can contain nodes',
    );
  });

  it('cycle: a frame cannot go inside itself or its own contents', () => {
    const board = ok(seeded(), [
      { op: 'add_node', id: 'inner', node: { type: 'frame', title: 'Inner', parent: 'f' } },
    ]).board;
    const found = errors(board, [
      { op: 'update_node', id: 'f', patch: { parent: 'inner' } },
      { op: 'update_node', id: 'f', patch: { parent: 'f' } },
    ]);
    expect(found.map((e) => e.code)).toEqual(['cycle', 'cycle']);
  });

  it('self_edge: an edge from a node to itself', () => {
    const [error] = errors(seeded(), [
      { op: 'add_edge', edge: { type: 'relates_to', source: 'n', target: 'n' } },
    ]);
    expect(error?.code).toBe('self_edge');
  });

  it('duplicate_edge: a second edge with the same type, source and target', () => {
    const board = ok(seeded(), [
      { op: 'add_edge', id: 'e1', edge: { type: 'relates_to', source: 't', target: 'n' } },
      { op: 'add_edge', id: 'e2', edge: { type: 'blocks', source: 't', target: 'n' } },
    ]).board;
    const found = errors(board, [
      { op: 'add_edge', edge: { type: 'relates_to', source: 't', target: 'n' } },
      { op: 'update_edge', id: 'e2', patch: { type: 'relates_to' } },
    ]);
    expect(found.map((e) => e.code)).toEqual(['duplicate_edge', 'duplicate_edge']);
  });

  it('refuses to turn a frame with contents into another type', () => {
    const [error] = errors(seeded(), [{ op: 'update_node', id: 'f', patch: { type: 'note' } }]);
    expect(error).toMatchObject({ code: 'invalid' });
    expect(error?.message).toContain('must stay a frame');
  });

  it('is atomic: one bad op means nothing is applied and every error is reported', () => {
    const board = freeze(seeded());
    const result = run(board, [
      { op: 'update_node', id: 't', patch: { title: 'Fine' } },
      { op: 'update_node', id: 'missing', patch: { title: 'x' } },
      { op: 'add_edge', edge: { type: 'relates_to', source: 'n', target: 'n' } },
      { op: 'add_node', node: { type: 'note', title: 'Fine too' } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => [e.index, e.code])).toEqual([
      [1, 'not_found'],
      [2, 'self_edge'],
    ]);
    expect(board.nodes.t?.title).toBe('Task');
  });

  it('does not repeat an error through refs to a node that failed to be added', () => {
    const found = errors(seeded(), [
      { op: 'add_node', ref: 'bad', node: { type: 'note', title: 'Bad', parent: 'n' } },
      { op: 'add_edge', edge: { type: 'relates_to', source: '$bad', target: 'n' } },
      { op: 'update_node', id: '$bad', patch: { status: 'done' } },
    ]);
    expect(found).toEqual([expect.objectContaining({ index: 0, code: 'not_a_frame' })]);
  });
});
