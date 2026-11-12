import { describe, expect, it } from 'vitest';
import { applyOps } from '../apply.js';
import type { Op } from '../ops.js';
import { type Actor, type Board, BoardSchema, type Comment } from '../schema.js';
import { emptyBoard, parseBoard, serializeBoard, validateBoard } from '../serialize.js';
import { mergeBoards } from './merge.js';
import { renderConflicts } from './report.js';

const ada: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const bob: Actor = { id: 'bob', kind: 'human', name: 'Bob' };
const bot: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };
const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-02T00:00:00.000Z');
const T2 = new Date('2026-01-03T00:00:00.000Z');
const T3 = new Date('2026-01-04T00:00:00.000Z');

function counter(prefix: string) {
  let i = 0;
  return (kind: string) => `${kind}_${prefix}${++i}`;
}

function apply(board: Board, ops: Op[], actor: Actor, now: Date, prefix: string): Board {
  const result = applyOps(board, ops, { actor, now, newId: counter(prefix) });
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result.board;
}

/** Frame F (with A and B inside), frame G, C outside; A depends on B. */
function baseBoard(): Board {
  return apply(
    emptyBoard({ id: 'main', name: 'Main' }, T0),
    [
      {
        op: 'add_node',
        id: 'F',
        node: { type: 'frame', title: 'Frame F', view: { x: 100, y: 100, w: 700, h: 400 } },
      },
      {
        op: 'add_node',
        id: 'G',
        node: { type: 'frame', title: 'Frame G', view: { x: 1000, y: 100, w: 400, h: 300 } },
      },
      {
        op: 'add_node',
        id: 'A',
        node: {
          type: 'task',
          title: 'Payment API',
          status: 'todo',
          parent: 'F',
          tags: ['api', 'x'],
          props: { owner: 'ada', size: 3 },
          links: [{ kind: 'file', target: 'src/a.ts', line: 1 }],
          view: { x: 32, y: 56 },
        },
      },
      {
        op: 'add_node',
        id: 'B',
        node: { type: 'task', title: 'Launch', parent: 'F', view: { x: 344, y: 56 } },
      },
      { op: 'add_node', id: 'C', node: { type: 'note', title: 'Context', view: { x: 0, y: 600 } } },
      { op: 'add_edge', id: 'AB', edge: { type: 'depends_on', source: 'A', target: 'B' } },
    ],
    ada,
    T1,
    'b',
  );
}

const ours = (base: Board, ops: Op[]) => apply(base, ops, ada, T2, 'o');
const theirs = (base: Board, ops: Op[]) => apply(base, ops, bob, T3, 't');

function expectValid(board: Board) {
  expect(validateBoard(board)).toEqual([]);
  expect(BoardSchema.safeParse(board).success).toBe(true);
  expect(() => parseBoard(serializeBoard(board))).not.toThrow();
}

describe('mergeBoards: fields', () => {
  it('takes each side’s change to different fields of the same node', () => {
    const base = baseBoard();
    const o = ours(base, [{ op: 'update_node', id: 'A', patch: { title: 'Payments API' } }]);
    const t = theirs(base, [
      { op: 'update_node', id: 'A', patch: { status: 'done', body: 'Shipped.' } },
    ]);
    const { board, conflicts, clean } = mergeBoards(base, o, t);
    expect(clean).toBe(true);
    expect(conflicts).toEqual([]);
    expect(board.nodes.A).toMatchObject({
      title: 'Payments API',
      status: 'done',
      body: 'Shipped.',
      updatedBy: 'bob',
      updatedAt: T3.toISOString(),
    });
    expect(board.updatedAt).toBe(T3.toISOString());
    expect(Object.keys(board.actors).sort()).toEqual(['ada', 'bob']);
    expectValid(board);
  });

  it('resolves the same field changed differently in favour of prefer, and says so', () => {
    const base = baseBoard();
    const o = ours(base, [{ op: 'update_node', id: 'A', patch: { status: 'done' } }]);
    const t = theirs(base, [{ op: 'update_node', id: 'A', patch: { status: 'blocked' } }]);
    const result = mergeBoards(base, o, t);
    expect(result.board.nodes.A?.status).toBe('done');
    expect(result.clean).toBe(false);
    expect(result.conflicts).toEqual([
      {
        kind: 'node',
        id: 'A',
        field: 'status',
        ours: 'done',
        theirs: 'blocked',
        resolution: 'ours',
        message:
          'Both sides changed the status of "Payment API" (ours: "done", theirs: "blocked"); kept ours.',
      },
    ]);
    const other = mergeBoards(base, o, t, { prefer: 'theirs' });
    expect(other.board.nodes.A?.status).toBe('blocked');
    expect(other.conflicts[0]?.resolution).toBe('theirs');
    // Bookkeeping follows the side that changed it last, whichever value won.
    expect(result.board.nodes.A?.updatedBy).toBe('bob');
  });

  it('merges tags and links as sets and props per key', () => {
    const base = baseBoard();
    const o = ours(base, [
      {
        op: 'update_node',
        id: 'A',
        patch: {
          tags: ['api', 'x', 'urgent'],
          props: { owner: 'ada', size: 5 },
          links: [
            { kind: 'file', target: 'src/a.ts', line: 1 },
            { kind: 'url', target: 'https://example.com' },
          ],
        },
      },
    ]);
    const t = theirs(base, [
      {
        op: 'update_node',
        id: 'A',
        patch: {
          tags: ['api', 'backend'],
          props: { owner: 'bob', size: 3, extra: true },
          links: [
            { kind: 'file', target: 'src/a.ts', line: 7 },
            { kind: 'commit', target: 'abc' },
          ],
        },
      },
    ]);
    const { board, conflicts } = mergeBoards(base, o, t);
    expect(board.nodes.A?.tags).toEqual(['api', 'backend', 'urgent']);
    expect(board.nodes.A?.props).toEqual({ owner: 'bob', size: 5, extra: true });
    expect(board.nodes.A?.links).toEqual([
      { kind: 'file', target: 'src/a.ts', line: 7 },
      { kind: 'commit', target: 'abc' },
      { kind: 'url', target: 'https://example.com' },
    ]);
    expect(conflicts).toEqual([]);
    expectValid(board);
  });

  it('reports a props key both sides changed differently', () => {
    const base = baseBoard();
    const o = ours(base, [
      { op: 'update_node', id: 'A', patch: { props: { owner: 'cy', size: 3 } } },
    ]);
    const t = theirs(base, [
      { op: 'update_node', id: 'A', patch: { props: { owner: 'di', size: 4 } } },
    ]);
    const { board, conflicts } = mergeBoards(base, o, t);
    expect(board.nodes.A?.props).toEqual({ owner: 'cy', size: 4 });
    expect(conflicts.map((c) => c.field)).toEqual(['props.owner']);
  });

  it('treats view as one field and keeps a position with the frame it belongs to', () => {
    const base = baseBoard();
    const moved = mergeBoards(
      base,
      ours(base, [{ op: 'move_node', id: 'C', view: { x: 10, y: 10 } }]),
      theirs(base, [{ op: 'move_node', id: 'C', view: { x: 20, y: 20 } }]),
    );
    expect(moved.board.nodes.C?.view).toEqual({ x: 10, y: 10 });
    expect(moved.conflicts.map((c) => c.field)).toEqual(['view']);

    // Ours moves A into G (its position cleared); theirs nudges A inside F.
    const o = ours(base, [{ op: 'update_node', id: 'A', patch: { parent: 'G' } }]);
    const t = theirs(base, [{ op: 'move_node', id: 'A', view: { x: 40, y: 60 } }]);
    const { board, conflicts } = mergeBoards(base, o, t);
    expect(board.nodes.A?.parent).toBe('G');
    expect(board.nodes.A?.view).toBeUndefined();
    expect(conflicts).toEqual([]);
  });

  it('merges board fields', () => {
    const base = baseBoard();
    const o = { ...ours(base, []), name: 'Ours' };
    const t = { ...theirs(base, []), description: 'Theirs' };
    const { board, conflicts } = mergeBoards(base, o, t);
    expect([board.name, board.description]).toEqual(['Ours', 'Theirs']);
    expect(conflicts).toEqual([]);
    const both = mergeBoards(base, { ...base, name: 'One' }, { ...base, name: 'Two' });
    expect(both.conflicts[0]).toMatchObject({ kind: 'meta', field: 'name', resolution: 'ours' });
  });
});

describe('mergeBoards: adds and removes', () => {
  it('keeps a node removed on one side but changed on the other, with its edges', () => {
    const base = baseBoard();
    const o = ours(base, [{ op: 'remove_node', id: 'B' }]);
    const t = theirs(base, [{ op: 'update_node', id: 'B', patch: { status: 'in_progress' } }]);
    const { board, conflicts } = mergeBoards(base, o, t);
    expect(board.nodes.B?.status).toBe('in_progress');
    expect(board.edges.AB).toBeDefined();
    expect(conflicts).toEqual([
      expect.objectContaining({
        kind: 'node',
        id: 'B',
        resolution: 'kept',
        message:
          '"Launch" was removed by ours but changed by theirs; it was kept, so remove it again if it should go.',
      }),
    ]);
    expectValid(board);
  });

  it('lets a removal win over a mere move', () => {
    const base = baseBoard();
    const o = ours(base, [{ op: 'remove_node', id: 'C' }]);
    const t = theirs(base, [{ op: 'move_node', id: 'C', view: { x: 5, y: 5 } }]);
    const result = mergeBoards(base, o, t);
    expect(result.board.nodes.C).toBeUndefined();
    expect(result.clean).toBe(true);
  });

  it('removes what both sides removed', () => {
    const base = baseBoard();
    const o = ours(base, [{ op: 'remove_node', id: 'C' }]);
    const t = theirs(base, [{ op: 'remove_node', id: 'C' }]);
    expect(mergeBoards(base, o, t).board.nodes.C).toBeUndefined();
  });

  it('merges a node both sides added with the same id', () => {
    const base = baseBoard();
    const add = (title: string, status: 'todo' | 'done'): Op => ({
      op: 'add_node',
      id: 'N',
      node: { type: 'task', title, status },
    });
    const same = mergeBoards(
      base,
      ours(base, [add('New', 'todo')]),
      theirs(base, [add('New', 'todo')]),
    );
    expect(same.conflicts).toEqual([]);
    expect(same.board.nodes.N).toMatchObject({ title: 'New', createdBy: 'ada', updatedBy: 'bob' });
    const different = mergeBoards(
      base,
      ours(base, [add('New', 'todo')]),
      theirs(base, [add('Newer', 'todo')]),
    );
    expect(different.board.nodes.N?.title).toBe('New');
    expect(different.conflicts).toEqual([
      expect.objectContaining({
        field: 'title',
        message:
          'Both sides added "New" with a different title (ours: "New", theirs: "Newer"); kept ours.',
      }),
    ]);
  });

  it('drops an edge whose node the other side removed', () => {
    const base = baseBoard();
    const o = ours(base, [{ op: 'remove_node', id: 'C' }]);
    const t = theirs(base, [
      { op: 'add_edge', id: 'AC', edge: { type: 'blocks', source: 'A', target: 'C' } },
    ]);
    const { board, conflicts } = mergeBoards(base, o, t);
    expect(board.edges.AC).toBeUndefined();
    expect(conflicts).toEqual([
      expect.objectContaining({
        kind: 'structure',
        id: 'AC',
        resolution: 'dropped',
        message:
          'Dropped the blocks edge from "Payment API" to "Context" because "Context" was removed.',
      }),
    ]);
    expectValid(board);
  });

  it('keeps one edge when both sides added the same relationship', () => {
    const base = baseBoard();
    const o = ours(base, [
      { op: 'add_edge', id: 'e_2', edge: { type: 'relates_to', source: 'C', target: 'A' } },
    ]);
    const t = theirs(base, [
      { op: 'add_edge', id: 'e_1', edge: { type: 'relates_to', source: 'C', target: 'A' } },
    ]);
    const { board, conflicts } = mergeBoards(base, o, t);
    expect(Object.keys(board.edges).sort()).toEqual(['AB', 'e_1']);
    expect(conflicts).toEqual([expect.objectContaining({ id: 'e_2', resolution: 'dropped' })]);
    expectValid(board);
  });
});

describe('mergeBoards: structure', () => {
  it('moves a node out of a frame the other side removed, keeping its place', () => {
    const base = baseBoard();
    const o = ours(base, [{ op: 'remove_node', id: 'G' }]);
    const t = theirs(base, [
      {
        op: 'add_node',
        id: 'N',
        node: { type: 'note', title: 'In G', parent: 'G', view: { x: 10, y: 20 } },
      },
    ]);
    const { board, conflicts } = mergeBoards(base, o, t);
    expect(board.nodes.N?.parent).toBeUndefined();
    expect(board.nodes.N?.view).toEqual({ x: 1010, y: 120 });
    expect(conflicts).toEqual([
      expect.objectContaining({
        kind: 'structure',
        resolution: 'repaired',
        message: 'Moved "In G" out of frame "Frame G", which the other side removed.',
      }),
    ]);
    expectValid(board);
  });

  it('moves a node out of a frame the other side turned into a card', () => {
    const base = baseBoard();
    const o = ours(base, [{ op: 'update_node', id: 'G', patch: { type: 'note' } }]);
    const t = theirs(base, [
      { op: 'add_node', id: 'N', node: { type: 'note', title: 'In G', parent: 'G' } },
    ]);
    const { board, conflicts } = mergeBoards(base, o, t);
    expect(board.nodes.N?.parent).toBeUndefined();
    expect(conflicts[0]?.message).toBe(
      'Moved "In G" out of "Frame G", which is no longer a frame.',
    );
    expectValid(board);
  });

  it('breaks a parent cycle made by the two sides', () => {
    const base = baseBoard();
    const o = ours(base, [{ op: 'update_node', id: 'F', patch: { parent: 'G' } }]);
    const t = theirs(base, [{ op: 'update_node', id: 'G', patch: { parent: 'F' } }]);
    const { board, conflicts } = mergeBoards(base, o, t);
    expect(board.nodes.F?.parent).toBeUndefined();
    expect(board.nodes.G?.parent).toBe('F');
    expect(conflicts).toEqual([
      expect.objectContaining({
        id: 'F',
        resolution: 'repaired',
        message:
          'Took "Frame F" out of "Frame G" because the two sides put these frames inside each other.',
      }),
    ]);
    expectValid(board);
  });

  it('keeps comments, detaching those whose node is gone, and merges their fields', () => {
    const base = baseBoard();
    const comment = (id: string, nodeId: string, body: string): Comment => ({
      id,
      thread: id,
      nodeId,
      author: 'ada',
      body,
      createdAt: T2.toISOString(),
    });
    const withComment = { ...base, comments: { c_1: comment('c_1', 'A', 'Looks good') } };
    const o = {
      ...ours(withComment, [{ op: 'remove_node', id: 'C' }]),
      comments: {
        c_1: {
          ...comment('c_1', 'A', 'Looks good'),
          resolvedAt: T2.toISOString(),
          resolvedBy: 'ada',
        },
      },
    };
    const t = {
      ...theirs(withComment, []),
      comments: {
        c_1: comment('c_1', 'A', 'Looks great'),
        c_2: comment('c_2', 'C', 'What is this?'),
      },
    };
    const { board, conflicts } = mergeBoards(withComment, o, t);
    expect(board.comments?.c_1).toMatchObject({ body: 'Looks great', resolvedBy: 'ada' });
    expect(board.comments?.c_2?.nodeId).toBe('C');
    expect(board.nodes.C).toBeUndefined();
    expect(conflicts).toEqual([
      expect.objectContaining({
        kind: 'structure',
        id: 'c_2',
        resolution: 'kept',
        message:
          'A comment on "Context" is now detached because the other side removed that node; reply on another node or resolve it.',
      }),
    ]);
    expectValid(board);
  });

  it('merges without a common ancestor', () => {
    const base = baseBoard();
    const same = mergeBoards(null, base, base);
    expect(serializeBoard(same.board)).toBe(serializeBoard(base));
    expect(same.clean).toBe(true);
    const renamed = mergeBoards(null, base, { ...base, name: 'Other' });
    expect(renamed.conflicts.map((c) => c.field)).toEqual(['name']);
    const mixed = mergeBoards(
      null,
      ours(base, [{ op: 'add_node', id: 'X', node: { type: 'note', title: 'X' } }]),
      theirs(base, [{ op: 'add_node', id: 'Y', node: { type: 'note', title: 'Y' } }]),
    );
    expect(Object.keys(mixed.board.nodes)).toEqual(expect.arrayContaining(['X', 'Y', 'A']));
    expectValid(mixed.board);
  });
});

describe('renderConflicts', () => {
  it('prints one line per conflict', () => {
    expect(renderConflicts([])).toBe('Merged cleanly: no conflicts.\n');
    const base = baseBoard();
    const { conflicts } = mergeBoards(
      base,
      ours(base, [{ op: 'update_node', id: 'A', patch: { title: 'One' } }]),
      theirs(base, [{ op: 'update_node', id: 'A', patch: { title: 'Two' } }]),
    );
    expect(renderConflicts(conflicts)).toBe(
      'Merged with 1 conflict, each resolved as shown; review them:\n' +
        '  [node] A title (kept ours): Both sides changed the title of "One" (ours: "One", theirs: "Two"); kept ours.\n',
    );
  });
});

// ── Property test ────────────────────────────────────────────────────────────

/** mulberry32: a small seeded PRNG. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T,
    chance: (p: number) => next() < p,
  };
}

type Rng = ReturnType<typeof prng>;

const TYPES = ['note', 'task', 'decision', 'risk', 'question'] as const;
const STATUSES = ['todo', 'in_progress', 'done', 'blocked'] as const;
const TAGS = ['a', 'b', 'c', 'd', 'e'];
const EDGE_TYPES = ['relates_to', 'depends_on', 'blocks'] as const;

function randomNode(rng: Rng, frames: string[]) {
  return {
    type: rng.pick(TYPES),
    title: `T${rng.int(1000)}`,
    ...(rng.chance(0.5) ? { status: rng.pick(STATUSES) } : {}),
    ...(rng.chance(0.5) ? { tags: TAGS.filter(() => rng.chance(0.4)) } : {}),
    ...(rng.chance(0.3) ? { props: { k: rng.int(3), [`p${rng.int(3)}`]: true } } : {}),
    ...(rng.chance(0.3)
      ? { links: [{ kind: 'file' as const, target: `src/${rng.int(5)}.ts` }] }
      : {}),
    ...(frames.length && rng.chance(0.5) ? { parent: rng.pick(frames) } : {}),
    ...(rng.chance(0.6) ? { view: { x: rng.int(50) * 8, y: rng.int(50) * 8 } } : {}),
  };
}

function randomBase(rng: Rng): Board {
  const ops: Op[] = [];
  const frames: string[] = [];
  const nodes: string[] = [];
  const frameCount = 1 + rng.int(3);
  for (let i = 0; i < frameCount; i++) {
    const id = `F${i}`;
    ops.push({
      op: 'add_node',
      id,
      node: {
        type: 'frame',
        title: `Frame ${i}`,
        ...(frames.length && rng.chance(0.5) ? { parent: rng.pick(frames) } : {}),
        view: { x: i * 400, y: 0 },
      },
    });
    frames.push(id);
  }
  const nodeCount = 3 + rng.int(8);
  for (let i = 0; i < nodeCount; i++) {
    const id = `N${i}`;
    ops.push({ op: 'add_node', id, node: randomNode(rng, frames) });
    nodes.push(id);
  }
  const all = [...frames, ...nodes];
  const seen = new Set<string>();
  for (let i = 0; i < nodeCount; i++) {
    const type = rng.pick(EDGE_TYPES);
    const source = rng.pick(all);
    const target = rng.pick(all);
    const key = `${type}${source}${target}`;
    if (source === target || seen.has(key)) continue;
    seen.add(key);
    ops.push({ op: 'add_edge', id: `E${i}`, edge: { type, source, target } });
  }
  let board = apply(emptyBoard({ id: 'prop', name: 'Prop' }, T0), ops, ada, T1, 'b');
  const comments: Record<string, Comment> = {};
  for (let i = 0; i < rng.int(3); i++) {
    comments[`C${i}`] = {
      id: `C${i}`,
      thread: `C${i}`,
      nodeId: rng.pick(nodes),
      author: 'ada',
      body: `Comment ${i}`,
      createdAt: T1.toISOString(),
    };
  }
  if (Object.keys(comments).length) board = { ...board, comments };
  return board;
}

/** Random edits, each applied on its own and skipped when invalid, so the side stays valid. */
function randomEdits(rng: Rng, base: Board, actor: Actor, now: Date, prefix: string): Board {
  let board = base;
  const ids = counter(prefix);
  const count = rng.int(6);
  for (let i = 0; i < count; i++) {
    const nodeIds = Object.keys(board.nodes);
    const frames = nodeIds.filter((id) => board.nodes[id]?.type === 'frame');
    const edgeIds = Object.keys(board.edges);
    let op: Op;
    switch (rng.int(9)) {
      case 0:
        op = { op: 'add_node', id: ids('n'), node: randomNode(rng, frames) };
        break;
      case 1:
        op = { op: 'update_node', id: rng.pick(nodeIds), patch: { title: `U${rng.int(100)}` } };
        break;
      case 2:
        op = {
          op: 'update_node',
          id: rng.pick(nodeIds),
          patch: { status: rng.pick(STATUSES), tags: TAGS.filter(() => rng.chance(0.4)) },
        };
        break;
      case 3:
        op = {
          op: 'update_node',
          id: rng.pick(nodeIds),
          patch: { parent: frames.length && rng.chance(0.7) ? rng.pick(frames) : null },
        };
        break;
      case 4:
        op = {
          op: 'move_node',
          id: rng.pick(nodeIds),
          view: { x: rng.int(50) * 8, y: rng.int(50) * 8 },
        };
        break;
      case 5:
        op = {
          op: 'remove_node',
          id: rng.pick(nodeIds),
          ...(rng.chance(0.3) ? { children: 'cascade' as const } : {}),
        };
        break;
      case 6:
        op = {
          op: 'add_edge',
          id: ids('e'),
          edge: {
            type: rng.pick(EDGE_TYPES),
            source: rng.pick(nodeIds),
            target: rng.pick(nodeIds),
          },
        };
        break;
      case 7:
        if (!edgeIds.length) continue;
        op = rng.chance(0.5)
          ? { op: 'remove_edge', id: rng.pick(edgeIds) }
          : { op: 'update_edge', id: rng.pick(edgeIds), patch: { label: `L${rng.int(9)}` } };
        break;
      default:
        op = {
          op: 'update_node',
          id: rng.pick(nodeIds),
          patch: { props: { k: rng.int(3) }, body: `B${rng.int(9)}` },
        };
    }
    if (!nodeIds.length && op.op !== 'add_node') continue;
    const result = applyOps(board, [op], { actor, now, newId: ids });
    if (result.ok) board = result.board;
  }
  // Now and then a comment is added or edited, outside the operation path as browsers do.
  if (rng.chance(0.3)) {
    const nodeIds = Object.keys(board.nodes);
    const id = rng.chance(0.5) && board.comments?.C0 ? 'C0' : `${prefix}c${rng.int(3)}`;
    const nodeId = nodeIds.length ? rng.pick(nodeIds) : undefined;
    board = {
      ...board,
      comments: {
        ...(board.comments ?? {}),
        [id]: {
          id,
          thread: id,
          ...(nodeId ? { nodeId } : {}),
          author: actor.id,
          body: `Edit ${rng.int(9)}`,
          createdAt: now.toISOString(),
        },
      },
    };
  }
  return board;
}

describe('mergeBoards: properties', () => {
  it('always yields a valid board, deterministically, with the merge identities', () => {
    let clean = 0;
    let conflicted = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rng = prng(seed);
      const base = randomBase(rng);
      const x = randomEdits(rng, base, ada, T2, 'x');
      const y = randomEdits(rng, base, rng.chance(0.5) ? bob : bot, T3, 'y');
      const context = `seed ${seed}`;

      const merged = mergeBoards(base, x, y);
      expect(validateBoard(merged.board), context).toEqual([]);
      expect(BoardSchema.safeParse(merged.board).success, context).toBe(true);
      const text = serializeBoard(merged.board);
      expect(serializeBoard(mergeBoards(base, x, y).board), context).toBe(text);
      expect(validateBoard(mergeBoards(base, x, y, { prefer: 'theirs' }).board), context).toEqual(
        [],
      );

      const keepX = mergeBoards(base, x, base);
      expect(serializeBoard(keepX.board), context).toBe(serializeBoard(x));
      expect(keepX.clean, context).toBe(true);
      const takeX = mergeBoards(base, base, x);
      expect(serializeBoard(takeX.board), context).toBe(serializeBoard(x));
      expect(takeX.clean, context).toBe(true);
      expect(serializeBoard(mergeBoards(base, x, x).board), context).toBe(serializeBoard(x));

      if (merged.clean) {
        clean++;
        expect(serializeBoard(mergeBoards(base, y, x).board), context).toBe(text);
      } else conflicted++;
    }
    // The generator must exercise both paths.
    expect(clean).toBeGreaterThan(50);
    expect(conflicted).toBeGreaterThan(20);
  });
});
