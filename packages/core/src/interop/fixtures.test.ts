/**
 * Boards the interop tests share, built through `applyOps` so they are always
 * valid. Imported by the other tests in this directory; the one test here
 * checks that the fixtures themselves are what the others assume.
 */
import { describe, expect, it } from 'vitest';
import { applyOps } from '../apply.js';
import type { Op } from '../ops.js';
import type { Actor, Board } from '../schema.js';
import { emptyBoard, validateBoard } from '../serialize.js';

export const ada: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
export const T0 = new Date('2026-01-01T00:00:00.000Z');
export const T1 = new Date('2026-01-02T00:00:00.000Z');

export function counter(prefix = '') {
  let i = 0;
  return (kind: string) => `${kind}_${prefix}${++i}`;
}

export function build(ops: Op[], meta = { id: 'main', name: 'Main' }): Board {
  const result = applyOps(emptyBoard(meta, T0), ops, { actor: ada, now: T1, newId: counter() });
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result.board;
}

/** Apply ops to an empty board, as an import would be applied. */
export function applyToEmpty(ops: Op[]): Board {
  const result = applyOps(emptyBoard({ id: 'imported', name: 'Imported' }, T0), ops, {
    actor: ada,
    now: T1,
    newId: counter('i'),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result.board;
}

export const HOSTILE = {
  quotes: 'He said "ship it" & left',
  brackets: 'Use [x] {y} (z) <b>bold</b> | pipe',
  newline: 'First line\nsecond line',
  entity: 'C# #quot; &amp; %% not a comment;',
  backticks: '`code` and ``more``',
  unicode: 'Ünïcödé façade, 日本語のタスク',
  keyword: 'end',
  markdown: '# Heading *star* _under_ ~strike~ $math$ \\slash',
} as const;

/**
 * Nested frames, every built-in node type and status, a custom type, every
 * edge type, hostile titles, links of every kind, and a mix of nodes with and
 * without positions.
 */
export function richBoard(): Board {
  return build(
    [
      {
        op: 'add_node',
        ref: 'outer',
        node: {
          type: 'frame',
          title: 'Checkout',
          body: 'Everything about paying.',
          view: { x: 0, y: 0, w: 1000, h: 760 },
        },
      },
      {
        op: 'add_node',
        ref: 'inner',
        node: {
          type: 'frame',
          title: 'Payment [API] "v2"',
          parent: '$outer',
          view: { x: 40, y: 360, w: 640, h: 360 },
        },
      },
      { op: 'add_node', ref: 'empty', node: { type: 'frame', title: 'Later' } },
      {
        op: 'add_node',
        ref: 'goal',
        node: {
          type: 'note',
          title: 'Ship the checkout flow',
          body: 'A **goal** with `code`.\n\n- one\n- two',
          tags: ['goal', 'q3 plan'],
          view: { x: 0, y: -200 },
        },
      },
      {
        op: 'add_node',
        ref: 'api',
        node: {
          type: 'task',
          title: 'Payment API',
          status: 'done',
          parent: '$inner',
          body: 'Stripe first.',
          links: [{ kind: 'file', target: 'src/pay/api.ts', line: 12, endLine: 40 }],
          view: { x: 32, y: 56 },
        },
      },
      {
        op: 'add_node',
        ref: 'retry',
        node: {
          type: 'task',
          title: 'Retry logic',
          status: 'in_progress',
          parent: '$inner',
          view: { x: 344, y: 56 },
        },
      },
      {
        op: 'add_node',
        ref: 'todo',
        node: { type: 'task', title: 'Write docs', status: 'todo', parent: '$outer' },
      },
      {
        op: 'add_node',
        ref: 'blocked',
        node: { type: 'task', title: 'Load test', status: 'blocked', parent: '$outer' },
      },
      {
        op: 'add_node',
        ref: 'cancel',
        node: { type: 'task', title: 'Old flow', status: 'cancelled' },
      },
      {
        op: 'add_node',
        ref: 'dec',
        node: { type: 'decision', title: 'Use Stripe', parent: '$outer', view: { x: 32, y: 56 } },
      },
      {
        op: 'add_node',
        ref: 'q',
        node: {
          type: 'question',
          title: HOSTILE.quotes,
          parent: '$outer',
          view: { x: 344, y: 56 },
        },
      },
      {
        op: 'add_node',
        ref: 'risk',
        node: { type: 'risk', title: HOSTILE.brackets, parent: '$outer', view: { x: 656, y: 56 } },
      },
      {
        op: 'add_node',
        ref: 'doc',
        node: {
          type: 'doc',
          title: 'Payment spec',
          links: [{ kind: 'file', target: 'docs/payment.md' }],
        },
      },
      {
        op: 'add_node',
        ref: 'code',
        node: {
          type: 'code',
          title: 'Session auth',
          links: [
            { kind: 'file', target: 'src/api/auth.ts' },
            { kind: 'symbol', target: 'src/api/auth.ts#login' },
            { kind: 'commit', target: 'abc1234' },
            { kind: 'pr', target: 'https://github.com/o/r/pull/7' },
          ],
        },
      },
      {
        op: 'add_node',
        ref: 'url',
        node: {
          type: 'doc',
          title: 'Stripe docs',
          links: [{ kind: 'url', target: 'https://stripe.com/docs' }],
        },
      },
      { op: 'add_node', ref: 'agent', node: { type: 'agent', title: HOSTILE.newline } },
      { op: 'add_node', ref: 'run', node: { type: 'run', title: HOSTILE.entity } },
      { op: 'add_node', ref: 'epic', node: { type: 'x:epic', title: HOSTILE.backticks } },
      { op: 'add_node', ref: 'uni', node: { type: 'note', title: HOSTILE.unicode } },
      { op: 'add_node', ref: 'kw', node: { type: 'note', title: HOSTILE.keyword } },
      { op: 'add_node', ref: 'md', node: { type: 'note', title: HOSTILE.markdown } },
      { op: 'add_edge', edge: { type: 'depends_on', source: '$retry', target: '$api' } },
      { op: 'add_edge', edge: { type: 'blocks', source: '$q', target: '$todo' } },
      { op: 'add_edge', edge: { type: 'relates_to', source: '$risk', target: '$api' } },
      { op: 'add_edge', edge: { type: 'implements', source: '$code', target: '$doc' } },
      {
        op: 'add_edge',
        edge: {
          type: 'evidence_for',
          source: '$url',
          target: '$dec',
          label: 'see "pricing" | fees',
        },
      },
      { op: 'add_edge', edge: { type: 'flows_to', source: '$goal', target: '$outer' } },
      { op: 'add_edge', edge: { type: 'x:mentions', source: '$agent', target: '$run' } },
      {
        op: 'add_edge',
        edge: { type: 'relates_to', source: '$epic', target: '$uni', label: 'see also' },
      },
    ],
    { id: 'main', name: 'Checkout <plan> & "more"' },
  );
}

/** About a dozen positioned nodes, laid out like the layout engine would, for looking at. */
export function showcaseBoard(): Board {
  return build(
    [
      {
        op: 'add_node',
        ref: 'f',
        node: { type: 'frame', title: 'Checkout flow', view: { x: 0, y: 0, w: 1000, h: 496 } },
      },
      {
        op: 'add_node',
        ref: 'g',
        node: {
          type: 'frame',
          title: 'Payments',
          parent: '$f',
          view: { x: 32, y: 56, w: 640, h: 408 },
        },
      },
      {
        op: 'add_node',
        ref: 'goal',
        node: {
          type: 'note',
          title: 'Ship the checkout flow by the end of the quarter',
          body: 'One page, guest checkout, saved cards.',
          tags: ['goal'],
          view: { x: 0, y: -232 },
        },
      },
      {
        op: 'add_node',
        ref: 'api',
        node: {
          type: 'task',
          title: 'Payment API',
          status: 'done',
          body: 'Stripe first, the rest later.',
          parent: '$g',
          links: [{ kind: 'file', target: 'src/pay/api.ts' }],
          view: { x: 32, y: 56 },
        },
      },
      {
        op: 'add_node',
        ref: 'retry',
        node: {
          type: 'task',
          title: 'Retry logic',
          status: 'in_progress',
          body: 'Exponential backoff, idempotency keys.',
          parent: '$g',
          tags: ['backend', 'payments', 'p1'],
          view: { x: 32, y: 232 },
        },
      },
      {
        op: 'add_node',
        ref: 'dc',
        node: {
          type: 'risk',
          title: 'Double charge on retry',
          body: 'If the first call timed out but succeeded.',
          status: 'blocked',
          parent: '$g',
          view: { x: 344, y: 232 },
        },
      },
      {
        op: 'add_node',
        ref: 'dec',
        node: { type: 'decision', title: 'Use Stripe', parent: '$g', view: { x: 344, y: 56 } },
      },
      {
        op: 'add_node',
        ref: 'q',
        node: {
          type: 'question',
          title: 'Do we need 3-D Secure for every card, or only "risky" ones?',
          parent: '$f',
          view: { x: 704, y: 56 },
        },
      },
      {
        op: 'add_node',
        ref: 'doc',
        node: {
          type: 'doc',
          title: 'Payment spec',
          links: [{ kind: 'file', target: 'docs/payment.md' }],
          view: { x: 1064, y: 56 },
        },
      },
      {
        op: 'add_node',
        ref: 'code',
        node: {
          type: 'code',
          title: 'checkout/session.ts',
          body: 'Creates the session and the cart snapshot.',
          view: { x: 1064, y: 200 },
        },
      },
      {
        op: 'add_node',
        ref: 'agent',
        node: { type: 'agent', title: 'Review agent', status: 'todo', view: { x: 344, y: -232 } },
      },
      {
        op: 'add_node',
        ref: 'run',
        node: {
          type: 'run',
          title: 'Load test #42',
          status: 'cancelled',
          view: { x: 704, y: -232 },
        },
      },
      { op: 'add_edge', edge: { type: 'depends_on', source: '$retry', target: '$api' } },
      { op: 'add_edge', edge: { type: 'relates_to', source: '$dc', target: '$retry' } },
      { op: 'add_edge', edge: { type: 'blocks', source: '$q', target: '$dc' } },
      { op: 'add_edge', edge: { type: 'implements', source: '$code', target: '$doc' } },
      {
        op: 'add_edge',
        edge: { type: 'evidence_for', source: '$doc', target: '$q', label: 'section 4' },
      },
      { op: 'add_edge', edge: { type: 'flows_to', source: '$goal', target: '$f' } },
      { op: 'add_edge', edge: { type: 'relates_to', source: '$agent', target: '$run' } },
    ],
    { id: 'showcase', name: 'Checkout plan' },
  );
}

describe('interop fixtures', () => {
  it('are valid boards with the variety the tests rely on', () => {
    const rich = richBoard();
    expect(validateBoard(rich)).toEqual([]);
    const types = new Set(Object.values(rich.nodes).map((node) => node.type));
    for (const type of [
      'note',
      'task',
      'decision',
      'question',
      'risk',
      'doc',
      'code',
      'agent',
      'run',
      'frame',
      'x:epic',
    ]) {
      expect(types.has(type)).toBe(true);
    }
    const edgeTypes = new Set(Object.values(rich.edges).map((edge) => edge.type));
    expect(edgeTypes.size).toBe(7);
    expect(Object.keys(showcaseBoard().nodes)).toHaveLength(12);
  });
});
