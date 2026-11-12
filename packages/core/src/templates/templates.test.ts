import { describe, expect, it } from 'vitest';
import {
  type Actor,
  applyOps,
  type Board,
  BUILTIN_TEMPLATES,
  countAdded,
  emptyBoard,
  findBuiltinTemplate,
  type Op,
  opsFromBoard,
  renderOutline,
  renderTemplates,
  TemplateIdSchema,
} from '../index.js';

const ada: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const bob: Actor = { id: 'bob', kind: 'agent', name: 'Bob' };

function counter() {
  let i = 0;
  return (prefix: string) => `${prefix}_${++i}`;
}

function applied(board: Board, ops: Op[], actor: Actor = ada): Board {
  const outcome = applyOps(board, ops, { actor, newId: counter() });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.errors));
  return outcome.board;
}

describe('built-in templates', () => {
  it('are the documented eight, with valid ids and real descriptions', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.id).sort()).toEqual([
      'agent-team',
      'architecture-map',
      'decision-record',
      'feature-plan',
      'incident-review',
      'kanban',
      'release-plan',
      'research-map',
    ]);
    for (const t of BUILTIN_TEMPLATES) {
      expect(TemplateIdSchema.safeParse(t.id).success, t.id).toBe(true);
      expect(t.description.length, t.id).toBeGreaterThan(60);
      expect(t.description, t.id).toMatch(/Use it /);
      expect(t.tags.length, t.id).toBeGreaterThan(0);
    }
  });

  for (const template of BUILTIN_TEMPLATES) {
    describe(template.id, () => {
      it('applies to an empty board in one valid batch, under one outer frame', () => {
        const ops = template.build();
        const board = applied(emptyBoard({ id: 'b', name: 'B' }), ops);
        const nodes = Object.values(board.nodes);
        const top = nodes.filter((n) => n.parent === undefined);
        expect(top).toHaveLength(1);
        expect(top[0]).toMatchObject({ type: 'frame', title: template.name });
        expect(nodes.length).toBeGreaterThanOrEqual(6);
        expect(Object.keys(board.edges).length).toBeGreaterThan(0);
        expect(nodes.every((n) => n.view === undefined)).toBe(true);
        expect(countAdded(ops)).toEqual({
          nodeCount: nodes.length,
          edgeCount: Object.keys(board.edges).length,
        });
      });

      it('builds the same batch every time and takes a title', () => {
        expect(template.build()).toEqual(template.build());
        const ops = template.build({ title: 'Checkout' });
        const first = ops[0];
        expect(first?.op === 'add_node' && first.node.title).toBe('Checkout');
      });

      it('reads well in an outline and carries no instructions to a reader', () => {
        const board = applied(emptyBoard({ id: 'b', name: 'B' }), template.build());
        const outline = renderOutline(board, 0).text;
        expect(outline).toContain(`"${template.name}"`);
        expect(outline).not.toContain('Truncated');
        const text = JSON.stringify(template.build()).toLowerCase();
        for (const word of ['you must', 'you should', 'ignore', 'instruction', 'always ']) {
          expect(text, `${template.id}: ${word}`).not.toContain(word);
        }
      });
    });
  }

  it('finds by id', () => {
    expect(findBuiltinTemplate('kanban')?.name).toBe('Kanban');
    expect(findBuiltinTemplate('nope')).toBeUndefined();
  });

  it('lists compactly', () => {
    const result = renderTemplates(
      BUILTIN_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        tags: t.tags,
        source: 'builtin' as const,
        ...countAdded(t.build()),
      })),
    );
    expect(result.text.split('\n')[0]).toContain('8 templates.');
    expect(result.text).toContain('feature-plan "Feature plan" (built-in;');
    expect(result.tokens).toBeLessThan(1000);
  });
});

describe('a board as a template', () => {
  function source(): Board {
    const board = applied(
      emptyBoard({ id: 'tpl', name: 'Weekly review' }),
      [
        {
          op: 'add_node',
          id: 'n_frame',
          node: { type: 'frame', title: 'Week', view: { x: 100, y: 100, w: 600, h: 400 } },
        },
        {
          op: 'add_node',
          id: 'n_task',
          node: {
            type: 'task',
            title: 'Review',
            status: 'todo',
            parent: 'n_frame',
            tags: ['weekly'],
            props: { 'x.weight': 2 },
            links: [{ kind: 'file', target: 'src/a.ts', hash: 'sha256:abc', stale: true }],
            view: { x: 20, y: 40 },
          },
        },
        {
          op: 'add_node',
          id: 'n_note',
          node: { type: 'note', title: 'Loose', view: { x: 0, y: 0 } },
        },
        {
          op: 'add_edge',
          id: 'e_1',
          edge: { type: 'relates_to', source: 'n_note', target: 'n_task', label: 'see' },
        },
      ],
      bob,
    );
    board.comments = {
      c_1: {
        id: 'c_1',
        thread: 'c_1',
        nodeId: 'n_task',
        author: 'bob',
        body: 'Not copied',
        createdAt: board.createdAt,
      },
    };
    return board;
  }

  it('copies nodes, edges and nested views with fresh ids, as the new author', () => {
    const ops = opsFromBoard(source());
    const target = applied(emptyBoard({ id: 'b', name: 'B' }), ops, ada);
    const nodes = Object.values(target.nodes);
    expect(nodes.map((n) => n.title).sort()).toEqual(['Loose', 'Review', 'Week']);
    for (const node of nodes) {
      expect(['n_frame', 'n_task', 'n_note']).not.toContain(node.id);
      expect(node.createdBy).toBe('ada');
      expect(node.updatedBy).toBe('ada');
    }
    const task = nodes.find((n) => n.title === 'Review');
    const frame = nodes.find((n) => n.title === 'Week');
    expect(task).toMatchObject({
      status: 'todo',
      tags: ['weekly'],
      props: { 'x.weight': 2 },
      parent: frame?.id,
      view: { x: 20, y: 40 },
      links: [{ kind: 'file', target: 'src/a.ts' }],
    });
    // Top-level positions are left to the layout unless asked for.
    expect(frame?.view).toBeUndefined();
    const edge = Object.values(target.edges)[0];
    expect(edge).toMatchObject({ type: 'relates_to', label: 'see', target: task?.id });
    expect(edge?.id).not.toBe('e_1');
    expect(target.comments).toBeUndefined();
    expect(JSON.stringify(ops)).not.toContain('Not copied');
  });

  it('keeps top-level positions on request', () => {
    const ops = opsFromBoard(source(), { keepTopLevelViews: true });
    const target = applied(emptyBoard({ id: 'b', name: 'B' }), ops);
    const frame = Object.values(target.nodes).find((n) => n.title === 'Week');
    expect(frame?.view).toEqual({ x: 100, y: 100, w: 600, h: 400 });
  });

  it('applies twice to the same board', () => {
    const ops = opsFromBoard(source());
    const once = applied(emptyBoard({ id: 'b', name: 'B' }), ops);
    const twice = applied(once, ops);
    expect(Object.keys(twice.nodes)).toHaveLength(6);
  });
});
