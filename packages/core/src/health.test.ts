import { describe, expect, it } from 'vitest';
import {
  type Actor,
  applyOps,
  type Board,
  BUILTIN_TEMPLATES,
  boardHealth,
  type EdgeInput,
  emptyBoard,
  type NodeInput,
  type Op,
} from './index.js';

const ada: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const T0 = new Date('2026-01-01T00:00:00.000Z');

function build(ops: Op[]): Board {
  const result = applyOps(emptyBoard({ id: 'main', name: 'Main' }, T0), ops, {
    actor: ada,
    now: T0,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.board;
}

const node = (id: string, input: Partial<NodeInput> & Pick<NodeInput, 'type'>): Op => ({
  op: 'add_node',
  id,
  node: { title: id, ...input },
});
const edge = (type: EdgeInput['type'], source: string, target: string): Op => ({
  op: 'add_edge',
  edge: { type, source, target },
});

const kinds = (board: Board) => boardHealth(board).map((f) => [f.kind, f.nodeIds]);

describe('boardHealth', () => {
  it('finds nothing on an empty board', () => {
    expect(boardHealth(build([]))).toEqual([]);
  });

  describe('unanswered questions', () => {
    it('lists an open question with nothing answering it', () => {
      const board = build([node('q', { type: 'question', title: 'Which columns?' })]);
      expect(boardHealth(board)).toEqual([
        {
          kind: 'unanswered_question',
          nodeIds: ['q'],
          reason: 'No decision answers it, and it is not marked done.',
        },
      ]);
    });

    it('counts a question marked done or cancelled as answered', () => {
      const board = build([
        node('q1', { type: 'question', status: 'done' }),
        node('q2', { type: 'question', status: 'cancelled' }),
      ]);
      expect(boardHealth(board)).toEqual([]);
    });

    it('lists a question that is in progress or blocked', () => {
      const board = build([
        node('q1', { type: 'question', status: 'in_progress' }),
        node('q2', { type: 'question', status: 'blocked' }),
      ]);
      expect(kinds(board)).toEqual([
        ['unanswered_question', ['q1']],
        ['unanswered_question', ['q2']],
      ]);
    });

    it('counts a linked decision as the answer, in either direction and by any edge type', () => {
      const board = build([
        node('q1', { type: 'question' }),
        node('q2', { type: 'question' }),
        node('d1', { type: 'decision' }),
        node('d2', { type: 'decision', status: 'done' }),
        edge('relates_to', 'q1', 'd1'),
        edge('evidence_for', 'd2', 'q2'),
      ]);
      expect(boardHealth(board)).toEqual([]);
    });

    it('does not count a decision that is still open or was cancelled', () => {
      const board = build([
        node('q1', { type: 'question' }),
        node('q2', { type: 'question' }),
        node('d1', { type: 'decision', status: 'todo' }),
        node('d2', { type: 'decision', status: 'cancelled' }),
        edge('relates_to', 'q1', 'd1'),
        edge('relates_to', 'q2', 'd2'),
      ]);
      expect(kinds(board)).toEqual([
        ['unanswered_question', ['q1']],
        ['unanswered_question', ['q2']],
      ]);
    });

    it('does not count other linked cards, such as findings or tasks', () => {
      const board = build([
        node('q', { type: 'question' }),
        node('n', { type: 'note' }),
        node('t', { type: 'task', status: 'done' }),
        edge('evidence_for', 'n', 'q'),
        edge('blocks', 'q', 't'),
      ]);
      expect(kinds(board)).toEqual([['unanswered_question', ['q']]]);
    });
  });

  describe('risks without mitigation', () => {
    it('lists an open risk that no task or decision is linked to', () => {
      const board = build([
        node('r', { type: 'risk' }),
        node('c', { type: 'code' }),
        edge('relates_to', 'r', 'c'),
      ]);
      expect(boardHealth(board)).toEqual([
        {
          kind: 'unmitigated_risk',
          nodeIds: ['r'],
          reason: 'No task or decision is linked to it.',
        },
      ]);
    });

    it('counts a linked task or decision, in either direction', () => {
      const board = build([
        node('r1', { type: 'risk' }),
        node('r2', { type: 'risk' }),
        node('t', { type: 'task', status: 'todo' }),
        node('d', { type: 'decision' }),
        edge('relates_to', 't', 'r1'),
        edge('blocks', 'r2', 'd'),
      ]);
      expect(boardHealth(board)).toEqual([]);
    });

    it('does not count a cancelled task', () => {
      const board = build([
        node('r', { type: 'risk' }),
        node('t', { type: 'task', status: 'cancelled' }),
        edge('relates_to', 't', 'r'),
      ]);
      expect(kinds(board)).toEqual([['unmitigated_risk', ['r']]]);
    });

    it('leaves out risks that are done or cancelled', () => {
      const board = build([
        node('r1', { type: 'risk', status: 'done' }),
        node('r2', { type: 'risk', status: 'cancelled' }),
      ]);
      expect(boardHealth(board)).toEqual([]);
    });
  });

  describe('blocked cards whose blockers are done', () => {
    it('lists a blocked task whose one blocker is done, naming it', () => {
      const board = build([
        node('t', { type: 'task', status: 'blocked' }),
        node('q', { type: 'question', title: 'Which columns?', status: 'done' }),
        edge('blocks', 'q', 't'),
      ]);
      expect(boardHealth(board)).toEqual([
        {
          kind: 'blocked_but_clear',
          nodeIds: ['t', 'q'],
          reason: 'Marked blocked, but “Which columns?” is done.',
        },
      ]);
    });

    it('counts dependencies and blockers together, done or cancelled', () => {
      const board = build([
        node('t', { type: 'task', status: 'blocked' }),
        node('a', { type: 'task', status: 'done' }),
        node('b', { type: 'task', status: 'cancelled' }),
        node('c', { type: 'task', status: 'done' }),
        edge('depends_on', 't', 'a'),
        edge('depends_on', 't', 'b'),
        edge('blocks', 'c', 't'),
      ]);
      expect(boardHealth(board)).toEqual([
        {
          kind: 'blocked_but_clear',
          nodeIds: ['t', 'a', 'b', 'c'],
          reason: 'Marked blocked, but all 3 cards it waits on are done or cancelled.',
        },
      ]);
    });

    it('says cancelled for a single cancelled blocker', () => {
      const board = build([
        node('t', { type: 'task', status: 'blocked' }),
        node('a', { type: 'task', title: 'Old plan', status: 'cancelled' }),
        edge('depends_on', 't', 'a'),
      ]);
      expect(boardHealth(board)[0]?.reason).toBe('Marked blocked, but “Old plan” is cancelled.');
    });

    it('counts a card that both blocks and is depended on once', () => {
      const board = build([
        node('t', { type: 'task', status: 'blocked' }),
        node('a', { type: 'task', title: 'A', status: 'done' }),
        edge('depends_on', 't', 'a'),
        edge('blocks', 'a', 't'),
      ]);
      expect(boardHealth(board)).toEqual([
        {
          kind: 'blocked_but_clear',
          nodeIds: ['t', 'a'],
          reason: 'Marked blocked, but “A” is done.',
        },
      ]);
    });

    it('stays quiet while any blocker is open', () => {
      const board = build([
        node('t', { type: 'task', status: 'blocked' }),
        node('a', { type: 'task', status: 'done' }),
        node('b', { type: 'task', status: 'in_progress' }),
        node('c', { type: 'task' }),
        node('u', { type: 'task', status: 'blocked' }),
        edge('depends_on', 't', 'a'),
        edge('depends_on', 't', 'b'),
        edge('blocks', 'c', 'u'),
      ]);
      expect(boardHealth(board)).toEqual([]);
    });

    it('stays quiet for a blocked card with no blockers on the board', () => {
      const board = build([
        node('t', { type: 'task', status: 'blocked' }),
        node('a', { type: 'task', status: 'done' }),
        // The wrong way round: t blocks a, a depends on t. Neither holds t up.
        edge('blocks', 't', 'a'),
        edge('relates_to', 't', 'a'),
      ]);
      expect(boardHealth(board)).toEqual([]);
    });

    it('applies to any card type, not only tasks', () => {
      const board = build([
        node('x', { type: 'x:bug', status: 'blocked' }),
        node('a', { type: 'task', status: 'done' }),
        edge('depends_on', 'x', 'a'),
      ]);
      expect(kinds(board)).toEqual([['blocked_but_clear', ['x', 'a']]]);
    });

    it('cuts a long blocker title', () => {
      const board = build([
        node('t', { type: 'task', status: 'blocked' }),
        node('a', { type: 'task', title: `${'word '.repeat(30)}end`, status: 'done' }),
        edge('depends_on', 't', 'a'),
      ]);
      const reason = boardHealth(board)[0]?.reason ?? '';
      expect(reason).toContain('…” is done.');
      expect(reason.length).toBeLessThan(110);
    });
  });

  describe('loose cards', () => {
    /** A frame holding `n` connected tasks. */
    const tidy = (n: number): Op[] => [
      node('f', { type: 'frame' }),
      ...Array.from({ length: n }, (_, i) =>
        node(`t${i}`, { type: 'task', status: 'todo', parent: 'f' }),
      ),
    ];

    it('lists a lone card on a board where everything else is framed or connected', () => {
      const board = build([
        ...tidy(4),
        node('a', { type: 'note' }),
        node('b', { type: 'note' }),
        edge('relates_to', 'a', 'b'),
        node('lone', { type: 'note', title: 'Stray thought' }),
      ]);
      expect(boardHealth(board)).toEqual([
        {
          kind: 'loose_card',
          nodeIds: ['lone'],
          reason: 'Not in a frame and not connected to anything.',
        },
      ]);
    });

    it('counts a connection to a frame', () => {
      const board = build([...tidy(5), node('n', { type: 'note' }), edge('relates_to', 'n', 'f')]);
      expect(boardHealth(board)).toEqual([]);
    });

    it('stays quiet on small boards', () => {
      const board = build([...tidy(4), node('lone', { type: 'note' })]);
      expect(boardHealth(board)).toEqual([]);
    });

    it('stays quiet where loose cards are common', () => {
      const board = build([...tidy(6), node('a', { type: 'note' }), node('b', { type: 'note' })]);
      // 2 of 8 cards are loose: a board kept that way on purpose.
      expect(boardHealth(board)).toEqual([]);
      expect(
        kinds(build([...tidy(8), node('a', { type: 'note' }), node('b', { type: 'note' })])),
      ).toEqual([
        ['loose_card', ['a']],
        ['loose_card', ['b']],
      ]);
    });

    it('never lists frames, and does not list a card twice', () => {
      const board = build([
        ...tidy(6),
        node('empty', { type: 'frame' }),
        node('q', { type: 'question' }),
      ]);
      expect(kinds(board)).toEqual([['unanswered_question', ['q']]]);
    });
  });

  it('orders findings by kind, then title, then id', () => {
    const board = build([
      node('t', { type: 'task', status: 'blocked' }),
      node('done', { type: 'task', status: 'done' }),
      edge('depends_on', 't', 'done'),
      node('r', { type: 'risk', title: 'Alpha' }),
      node('q2', { type: 'question', title: 'Same' }),
      node('q1', { type: 'question', title: 'Same' }),
      node('q0', { type: 'question', title: 'Earlier' }),
    ]);
    expect(kinds(board)).toEqual([
      ['unanswered_question', ['q0']],
      ['unanswered_question', ['q1']],
      ['unanswered_question', ['q2']],
      ['unmitigated_risk', ['r']],
      ['blocked_but_clear', ['t', 'done']],
    ]);
  });

  it('ignores edges whose ends are missing', () => {
    const board = build([node('q', { type: 'question' })]);
    const broken: Board = {
      ...board,
      edges: {
        e: {
          id: 'e',
          type: 'relates_to',
          source: 'q',
          target: 'gone',
          createdBy: 'ada',
          createdAt: T0.toISOString(),
          updatedBy: 'ada',
          updatedAt: T0.toISOString(),
        },
      },
    };
    expect(kinds(broken)).toEqual([['unanswered_question', ['q']]]);
  });

  it('flags only the open questions and the risk the built-in templates leave open', () => {
    const found: Record<string, string[]> = {};
    for (const template of BUILTIN_TEMPLATES) {
      const board = build(template.build());
      found[template.id] = boardHealth(board).map(
        (f) => `${f.kind}: ${board.nodes[f.nodeIds[0] as string]?.title}`,
      );
    }
    expect(found).toEqual({
      'feature-plan': ['unanswered_question: Which columns go into the export?'],
      'architecture-map': [
        'unanswered_question: Who owns billing?',
        'unmitigated_risk: One database for everything',
      ],
      'release-plan': [],
      'incident-review': [],
      'decision-record': [],
      'research-map': [
        'unanswered_question: Why do trial users not convert?',
        'unanswered_question: Would a longer trial help?',
      ],
      kanban: [],
      'agent-team': [],
    });
  });
});
