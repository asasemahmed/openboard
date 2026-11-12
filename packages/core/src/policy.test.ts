import { describe, expect, it } from 'vitest';
import {
  type Actor,
  applyOps,
  type Board,
  classifyOps,
  DEFAULT_CONFIG,
  emptyBoard,
  FRAME_POLICY_PROP,
  type Op,
  type OpVerdict,
  type PolicyMode,
  type ProjectConfig,
} from './index.js';

const ada: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const bot: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };
const T0 = new Date('2026-01-01T00:00:00.000Z');

function counter() {
  let i = 0;
  return (prefix: string) => `${prefix}_${++i}`;
}

function step(board: Board, actor: Actor, ops: unknown[]): Board {
  const result = applyOps(board, ops as Op[], { actor, now: T0, newId: counter() });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.board;
}

const frame = (id: string, policy?: string, parent?: string) => ({
  op: 'add_node',
  id,
  node: {
    type: 'frame',
    title: `Frame ${id}`,
    ...(policy ? { props: { [FRAME_POLICY_PROP]: policy } } : {}),
    ...(parent ? { parent } : {}),
  },
});
const note = (id: string, parent?: string, view?: object) => ({
  op: 'add_node',
  id,
  node: {
    type: 'note',
    title: `Note ${id}`,
    ...(parent ? { parent } : {}),
    ...(view ? { view } : {}),
  },
});

/**
 * ada (human) owns: h, hp (pinned), the frames, in_auto; bot owns: a, ap
 * (pinned), ae (edited by ada later), in_review, in_locked, deep, plain_a.
 * Frames: f_auto, f_review, f_locked, f_plain (no policy), f_free (auto,
 * nested in f_locked), f_inner (no policy, nested in f_review).
 */
function fixture(): Board {
  let board = emptyBoard({ id: 'main', name: 'Main' }, T0);
  board = step(board, ada, [
    frame('f_auto', 'auto'),
    frame('f_review', 'review'),
    frame('f_locked', 'locked'),
    frame('f_plain'),
    frame('f_free', 'auto', 'f_locked'),
    frame('f_inner', undefined, 'f_review'),
    note('h'),
    note('hp', undefined, { x: 0, y: 0, pinned: true }),
    note('in_auto', 'f_auto'),
  ]);
  board = step(board, bot, [
    note('a'),
    note('ap', undefined, { x: 5, y: 5, pinned: true }),
    note('ae'),
    note('in_review', 'f_review'),
    note('in_locked', 'f_locked'),
    note('deep', 'f_free'),
    note('plain_a', 'f_plain'),
    note('inner_a', 'f_inner'),
    { op: 'add_edge', id: 'e_a', edge: { type: 'relates_to', source: 'a', target: 'ae' } },
  ]);
  board = step(board, ada, [
    { op: 'update_node', id: 'ae', patch: { body: 'edited by ada' } },
    { op: 'add_edge', id: 'e_h', edge: { type: 'relates_to', source: 'h', target: 'a' } },
  ]);
  return board;
}

const BOARD = fixture();

function config(mode: PolicyMode): ProjectConfig {
  return { version: 1, policy: { default: mode, agents: {} } };
}

function verdicts(ops: unknown[], mode: PolicyMode, actor: Actor = bot): OpVerdict[] {
  return classifyOps(BOARD, ops as Op[], { actor, config: config(mode) }).map((c) => c.verdict);
}

const add = { op: 'add_node', node: { type: 'note', title: 'New' } };
const addIn = (parent: string) => ({
  op: 'add_node',
  node: { type: 'note', title: 'New', parent },
});
const upd = (id: string) => ({ op: 'update_node', id, patch: { title: 'Changed' } });
const rm = (id: string) => ({ op: 'remove_node', id });
const mv = (id: string) => ({ op: 'move_node', id, view: { x: 50, y: 50 } });
const addEdge = (source: string, target: string) => ({
  op: 'add_edge',
  edge: { type: 'blocks', source, target },
});
const updEdge = (id: string) => ({ op: 'update_edge', id, patch: { label: 'x' } });
const rmEdge = (id: string) => ({ op: 'remove_edge', id });

type Row = [name: string, op: unknown, expected: Record<PolicyMode, OpVerdict>];
const all = (v: OpVerdict, locked: OpVerdict = 'denied'): Record<PolicyMode, OpVerdict> => ({
  auto: v,
  review_destructive: v,
  review_all: v,
  locked,
});
const byMode = (destructive: OpVerdict): Record<PolicyMode, OpVerdict> => ({
  auto: 'free',
  review_destructive: destructive,
  review_all: 'review',
  locked: 'denied',
});

const TABLE: Row[] = [
  // Root level: the agent's mode decides.
  ['add_node at the root', add, byMode('free')],
  ['update own node', upd('a'), byMode('free')],
  ['update a node a person created', upd('h'), byMode('review')],
  ['update own node a person edited since', upd('ae'), byMode('review')],
  ['remove own node', rm('ap'), byMode('free')],
  ['remove own node that a person’s edge touches', rm('a'), byMode('review')],
  ['remove a node a person created (and its edge)', rm('h'), byMode('review')],
  ['move an unpinned node of a person', mv('h'), byMode('free')],
  ['move own unpinned node', mv('a'), byMode('free')],
  ['move a node a person pinned', mv('hp'), byMode('review')],
  ['move own node a person pinned', mv('ap'), byMode('review')],
  ['add an edge to a person’s node', addEdge('a', 'h'), byMode('free')],
  ['update own edge', updEdge('e_a'), byMode('free')],
  ['update a person’s edge', updEdge('e_h'), byMode('review')],
  ['remove own edge', rmEdge('e_a'), byMode('free')],
  ['remove a person’s edge', rmEdge('e_h'), byMode('review')],
  // A plain frame changes nothing.
  ['add inside a frame without policy', addIn('f_plain'), byMode('free')],
  ['update own node in a plain frame', upd('plain_a'), byMode('free')],
  ['update the plain frame a person made', upd('f_plain'), byMode('review')],
  // auto frames free a workspace (but a locked agent stays locked).
  ['add inside an auto frame', addIn('f_auto'), all('free')],
  ['update a person’s node inside an auto frame', upd('in_auto'), all('free')],
  ['remove a person’s node inside an auto frame', rm('in_auto'), all('free')],
  ['update the auto frame itself', upd('f_auto'), all('free')],
  // review frames protect an area.
  ['add inside a review frame', addIn('f_review'), all('review')],
  ['update own node inside a review frame', upd('in_review'), all('review')],
  ['move own node inside a review frame', mv('in_review'), all('review')],
  ['update own node in a plain frame nested in a review frame', upd('inner_a'), all('review')],
  ['update the review frame itself', upd('f_review'), all('review')],
  ['add an edge to a node in a review frame', addEdge('a', 'in_review'), all('review')],
  // locked frames are read-only for agents.
  ['add inside a locked frame', addIn('f_locked'), all('denied')],
  ['update own node inside a locked frame', upd('in_locked'), all('denied')],
  ['move own node inside a locked frame', mv('in_locked'), all('denied')],
  ['remove the locked frame', rm('f_locked'), all('denied')],
  ['add an edge to a node in a locked frame', addEdge('a', 'in_locked'), all('denied')],
  // The nearest frame wins: an auto frame inside a locked one is free.
  ['update own node in an auto frame nested in a locked frame', upd('deep'), all('free')],
  ['add inside an auto frame nested in a locked frame', addIn('f_free'), all('free')],
  // Moving into and out of frames.
  [
    'move own node into a review frame',
    { op: 'update_node', id: 'a', patch: { parent: 'f_review' } },
    all('review'),
  ],
  [
    'move own node out of a review frame',
    { op: 'update_node', id: 'in_review', patch: { parent: null } },
    all('review'),
  ],
  [
    'move own node into a locked frame',
    { op: 'update_node', id: 'a', patch: { parent: 'f_locked' } },
    all('denied'),
  ],
  [
    'move own node out of a locked frame',
    { op: 'update_node', id: 'in_locked', patch: { parent: null } },
    all('denied'),
  ],
  [
    'move own node into a plain frame',
    { op: 'update_node', id: 'a', patch: { parent: 'f_plain' } },
    byMode('free'),
  ],
  [
    'move a person’s node out of an auto frame',
    { op: 'update_node', id: 'in_auto', patch: { parent: null } },
    all('free'),
  ],
  // Removing a frame judges its children.
  [
    'remove a plain frame holding own node (children are lifted out)',
    { op: 'remove_node', id: 'f_plain' },
    byMode('review'),
  ],
];

describe('classifyOps', () => {
  for (const [name, op, expected] of TABLE) {
    for (const mode of ['auto', 'review_destructive', 'review_all', 'locked'] as const) {
      it(`${mode}: ${name} -> ${expected[mode]}`, () => {
        expect(verdicts([op], mode)).toEqual([expected[mode]]);
      });
    }
  }

  it('never restricts people, whatever the mode or frame', () => {
    const ops = TABLE.map(([, op]) => op);
    for (const mode of ['auto', 'review_destructive', 'review_all', 'locked'] as const) {
      const all = ops.map((op) => verdicts([op], mode, ada)[0]);
      expect(new Set(all)).toEqual(new Set(['free']));
    }
  });

  it('treats operations on nodes created earlier in the batch as adding', () => {
    const ops = [
      { op: 'add_node', ref: 'x', node: { type: 'task', title: 'X' } },
      { op: 'update_node', id: '$x', patch: { status: 'done' } },
      { op: 'move_node', id: '$x', view: { x: 1, y: 1, pinned: true } },
      { op: 'move_node', id: '$x', view: { x: 2, y: 2 } },
      { op: 'add_edge', id: 'e_new', edge: { type: 'blocks', source: '$x', target: 'h' } },
      { op: 'update_edge', id: 'e_new', patch: { label: 'later' } },
      { op: 'remove_edge', id: 'e_new' },
      { op: 'remove_node', id: '$x' },
    ];
    expect(verdicts(ops, 'review_destructive')).toEqual(Array(ops.length).fill('free'));
    expect(verdicts(ops, 'review_all')).toEqual(Array(ops.length).fill('review'));
  });

  it('judges a node created in the batch where it ends up', () => {
    const ops = [
      { op: 'add_node', ref: 'x', node: { type: 'task', title: 'X' } },
      { op: 'update_node', id: '$x', patch: { parent: 'f_locked' } },
      { op: 'update_node', id: '$x', patch: { parent: 'f_review' } },
      { op: 'update_node', id: '$x', patch: { parent: 'f_auto' } },
    ];
    expect(verdicts(ops, 'review_all')).toEqual(['review', 'denied', 'denied', 'review']);
  });

  it('uses the frame policy from before the batch, so a batch cannot loosen it', () => {
    const ops = [
      { op: 'update_node', id: 'f_locked', patch: { props: { [FRAME_POLICY_PROP]: 'auto' } } },
      addIn('f_locked'),
    ];
    expect(verdicts(ops, 'auto')).toEqual(['denied', 'denied']);
  });

  it('applies the policy of a frame created in the same batch to its contents', () => {
    const ops = [
      {
        op: 'add_node',
        ref: 'w',
        node: { type: 'frame', title: 'Workspace', props: { [FRAME_POLICY_PROP]: 'auto' } },
      },
      { op: 'add_node', node: { type: 'note', title: 'Inside', parent: '$w' } },
    ];
    expect(verdicts(ops, 'review_all')).toEqual(['review', 'free']);
  });

  it('judges a cascade removal by everything it removes', () => {
    const op = { op: 'remove_node', id: 'f_review', children: 'cascade' };
    expect(verdicts([op], 'auto')).toEqual(['review']);
  });

  it('uses the per-agent mode before the default', () => {
    const cfg: ProjectConfig = {
      version: 1,
      policy: { default: 'locked', agents: { bot: 'auto' } },
    };
    expect(classifyOps(BOARD, [upd('h')] as Op[], { actor: bot, config: cfg })[0]?.verdict).toBe(
      'free',
    );
    const other: Actor = { id: 'other', kind: 'agent', name: 'Other' };
    expect(classifyOps(BOARD, [add] as Op[], { actor: other, config: cfg })[0]?.verdict).toBe(
      'denied',
    );
  });

  it('defaults to review_destructive and explains every verdict that is not free', () => {
    const result = classifyOps(BOARD, [add, upd('h'), mv('hp'), addIn('f_locked')] as Op[], {
      actor: bot,
      config: DEFAULT_CONFIG,
    });
    expect(result.map((r) => r.verdict)).toEqual(['free', 'review', 'review', 'denied']);
    expect(result[0]?.why).toBeUndefined();
    expect(result[1]?.why).toBe('changes "Note h", which Ada created');
    expect(result[2]?.why).toContain('pinned');
    expect(result[3]?.why).toContain('locked frame "Frame f_locked"');
  });
});
