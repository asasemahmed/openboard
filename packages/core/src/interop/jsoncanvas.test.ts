import { describe, expect, it } from 'vitest';
import type { Board } from '../schema.js';
import { applyToEmpty, build, HOSTILE, richBoard } from './fixtures.test.js';
import { type CanvasNode, fromJsonCanvas, toJsonCanvas, toJsonCanvasObject } from './jsoncanvas.js';
import { boardGeometry } from './layout.js';
import { oneLine } from './text.js';

function overlaps(a: CanvasNode, b: CanvasNode): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('toJsonCanvas', () => {
  const board = richBoard();
  const canvas = toJsonCanvasObject(board);
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]));
  const idOf = (title: string) =>
    Object.values(board.nodes).find((n) => n.title === title)?.id as string;

  it('keeps board ids and puts groups first, outer before inner', () => {
    expect(new Set(canvas.nodes.map((n) => n.id))).toEqual(new Set(Object.keys(board.nodes)));
    expect(canvas.nodes.slice(0, 3).map((n) => n.type)).toEqual(['group', 'group', 'group']);
    expect(canvas.nodes[0]?.label).toBe('Checkout');
    expect(canvas.edges.map((e) => e.id).sort()).toEqual(Object.keys(board.edges).sort());
  });

  it('uses absolute positions', () => {
    const inner = byId.get(idOf('Payment [API] "v2"')) as CanvasNode;
    const api = byId.get(idOf('Payment API')) as CanvasNode;
    expect([inner.x, inner.y]).toEqual([40, 360]);
    expect([api.x, api.y]).toEqual([40 + 32, 360 + 56]);
    expect([api.width, api.height]).toEqual([264, 144]);
  });

  it('places nodes without a view on a grid that overlaps nothing', () => {
    const cards = canvas.nodes.filter((n) => n.type !== 'group');
    for (const a of cards) for (const b of cards) if (a !== b) expect(overlaps(a, b)).toBe(false);
    const outer = byId.get(idOf('Checkout')) as CanvasNode;
    for (const title of ['Write docs', 'Load test']) {
      const node = byId.get(idOf(title)) as CanvasNode;
      expect(node.x >= outer.x && node.x + node.width <= outer.x + outer.width).toBe(true);
      expect(node.y >= outer.y && node.y + node.height <= outer.y + outer.height).toBe(true);
    }
  });

  it('chooses file, link and text nodes as the spec says', () => {
    expect(byId.get(idOf('Payment spec'))).toMatchObject({ type: 'file', file: 'docs/payment.md' });
    expect(byId.get(idOf('Session auth'))).toMatchObject({ type: 'file', file: 'src/api/auth.ts' });
    expect(byId.get(idOf('Stripe docs'))).toMatchObject({
      type: 'link',
      url: 'https://stripe.com/docs',
    });
    const api = byId.get(idOf('Payment API'));
    expect(api?.text).toBe('## Payment API\ntask · done\n\nStripe first.');
    expect(api?.color).toBe('4');
    const goal = byId.get(idOf('Ship the checkout flow'));
    expect(goal?.text?.split('\n')[1]).toBe('note · #goal #"q3 plan"');
    expect(byId.get(idOf(HOSTILE.newline))?.text?.startsWith('## First line second line\n')).toBe(
      true,
    );
  });

  it('labels edges with their type unless they have their own label', () => {
    const labels = canvas.edges.map((e) => e.label ?? '(none)').sort();
    expect(labels).toEqual(
      [
        '(none)',
        'blocks',
        'depends on',
        'flows to',
        'implements',
        'mentions',
        'see "pricing" | fees',
        'see also',
      ].sort(),
    );
    for (const edge of canvas.edges) {
      expect(['top', 'right', 'bottom', 'left']).toContain(edge.fromSide);
      expect(['top', 'right', 'bottom', 'left']).toContain(edge.toSide);
    }
  });

  it('writes valid JSON text', () => {
    expect(JSON.parse(toJsonCanvas(board))).toEqual(canvas);
    expect(toJsonCanvas(build([]))).toBe('{\n  "nodes": [],\n  "edges": []\n}\n');
  });
});

/** Everything the round trip must keep, keyed by title. */
function summary(board: Board) {
  const { rects } = boardGeometry(board);
  const title = (id: string | undefined) => (id ? oneLine(board.nodes[id]?.title ?? '?') : '-');
  return {
    nodes: Object.values(board.nodes)
      .map((n) => {
        const r = rects.get(n.id);
        return `${title(n.id)} in ${title(n.parent)} at ${Math.round(r?.x ?? 0)},${Math.round(r?.y ?? 0)} ${Math.round(r?.w ?? 0)}x${Math.round(r?.h ?? 0)}`;
      })
      .sort(),
    edges: Object.values(board.edges)
      .map((e) => `${title(e.source)} -> ${title(e.target)}`)
      .sort(),
  };
}

describe('fromJsonCanvas', () => {
  it('round-trips a board through a canvas', () => {
    const board = richBoard();
    const result = fromJsonCanvas(toJsonCanvas(board));
    expect(result.warnings).toEqual([]);
    const back = applyToEmpty(result.ops);
    const before = summary(board);
    const after = summary(back);
    // File and link nodes carry a path or URL instead of a title.
    const renamed: Record<string, string> = {
      'Payment spec': 'docs/payment.md',
      'Session auth': 'src/api/auth.ts',
      'Stripe docs': 'https://stripe.com/docs',
    };
    const rename = (line: string) => {
      for (const [from, to] of Object.entries(renamed)) line = line.split(from).join(to);
      return line;
    };
    expect(after.nodes).toEqual(before.nodes.map(rename).sort());
    expect(after.edges).toEqual(before.edges.map(rename).sort());
    // Text nodes keep type, status, tags and body.
    const find = (b: Board, t: string) => Object.values(b.nodes).find((n) => n.title === t);
    expect(find(back, 'Payment API')).toMatchObject({
      type: 'task',
      status: 'done',
      body: 'Stripe first.',
    });
    expect(find(back, 'Ship the checkout flow')?.tags).toEqual(['goal', 'q3 plan']);
    expect(find(back, HOSTILE.backticks)?.type).toBe('x:epic');
    // Edge types come back from their labels.
    const types = Object.values(back.edges)
      .map((e) => e.type)
      .sort();
    expect(types).toEqual(
      [
        'blocks',
        'depends_on',
        'flows_to',
        'implements',
        'relates_to',
        'relates_to',
        'relates_to',
        'relates_to',
      ].sort(),
    );
    for (const node of Object.values(back.nodes)) expect(node.view?.pinned).toBe(true);
  });

  it('round-trips a canvas through a board', () => {
    const canvas = {
      nodes: [
        {
          id: 'g1',
          type: 'group',
          x: -100,
          y: -100,
          width: 800,
          height: 600,
          label: 'Big',
          color: '3',
        },
        { id: 'g2', type: 'group', x: 0, y: 0, width: 400, height: 300, label: 'Small' },
        {
          id: 't1',
          type: 'text',
          x: 20,
          y: 40,
          width: 250,
          height: 120,
          text: 'Just a line\nand more',
        },
        {
          id: 't2',
          type: 'text',
          x: 450,
          y: 50,
          width: 200,
          height: 100,
          text: '# Heading\nBody **bold**',
        },
        {
          id: 'f1',
          type: 'file',
          x: 900,
          y: 0,
          width: 300,
          height: 200,
          file: 'notes/a.md',
          subpath: '#Intro',
        },
        {
          id: 'l1',
          type: 'link',
          x: 900,
          y: 300,
          width: 300,
          height: 200,
          url: 'https://example.com',
        },
      ],
      edges: [
        {
          id: 'e1',
          fromNode: 't1',
          toNode: 't2',
          label: 'next',
          fromSide: 'right',
          toSide: 'left',
        },
        { id: 'e2', fromNode: 'f1', toNode: 'l1' },
      ],
    };
    const back = applyToEmpty(fromJsonCanvas(JSON.stringify(canvas)).ops);
    const again = toJsonCanvasObject(back);
    const geometry = (n: { x: number; y: number; width: number; height: number; type: string }) =>
      `${n.type} ${n.x},${n.y} ${n.width}x${n.height}`;
    expect(again.nodes.map(geometry).sort()).toEqual(canvas.nodes.map(geometry).sort());
    const titled = Object.values(back.nodes).map(
      (n) => `${n.title} in ${back.nodes[n.parent ?? '']?.title ?? '-'}`,
    );
    expect(titled.sort()).toEqual(
      [
        'Big in -',
        'Small in Big',
        'Just a line in Small',
        'Heading in Big',
        'notes/a.md in -',
        'https://example.com in -',
      ].sort(),
    );
    expect(Object.values(back.nodes).find((n) => n.title === 'Heading')?.body).toBe(
      'Body **bold**',
    );
    expect(Object.values(back.nodes).find((n) => n.title === 'notes/a.md')).toMatchObject({
      type: 'code',
      links: [{ kind: 'file', target: 'notes/a.md' }],
    });
    expect(again.edges.map((e) => e.label ?? '-').sort()).toEqual(['-', 'next']);
  });

  it('puts a node in the innermost group that contains its centre', () => {
    const result = fromJsonCanvas(
      JSON.stringify({
        nodes: [
          { id: 'a', type: 'group', x: 0, y: 0, width: 1000, height: 1000 },
          { id: 'b', type: 'group', x: 100, y: 100, width: 500, height: 500, label: 'B' },
          { id: 'c', type: 'group', x: 100, y: 100, width: 500, height: 500, label: 'C' },
          // Centre inside b, though it sticks out of it.
          { id: 'n', type: 'text', x: 450, y: 450, width: 300, height: 100, text: 'Edge case' },
        ],
        edges: [],
      }),
    );
    const board = applyToEmpty(result.ops);
    const parentTitle = (title: string) => {
      const node = Object.values(board.nodes).find((n) => n.title === title);
      return node?.parent ? board.nodes[node.parent]?.title : undefined;
    };
    expect(parentTitle('Edge case')).toBe('C');
    expect(parentTitle('C')).toBe('B');
    expect(parentTitle('B')).toBe('Group');
  });

  it('tolerates unknown fields and reports what it skips', () => {
    const result = fromJsonCanvas(
      JSON.stringify({
        version: '1.0',
        extra: { anything: true },
        nodes: [
          {
            id: 'a',
            type: 'text',
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            text: 'A',
            styleAttributes: {},
          },
          { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'dup' },
          { id: 'b', type: 'widget', x: 200, y: 0, width: 100, height: 50 },
          { id: 'c', type: 'text', text: '' },
          'nonsense',
        ],
        edges: [
          { id: 'e1', fromNode: 'a', toNode: 'b', label: 'x'.repeat(200) },
          { id: 'e2', fromNode: 'a', toNode: 'missing' },
          { id: 'e3', fromNode: 'a', toNode: 'a' },
          { id: 'e4', fromNode: 'a', toNode: 'b', label: 'x'.repeat(200) },
        ],
      }),
    );
    expect(result.warnings).toEqual([
      'node id "a" is used twice; the second one was skipped.',
      'node "c" has no position; it was placed at 0,0.',
      'node 4 is not an object; skipped.',
      'node "b" has unknown type "widget"; imported as a note.',
      'text node "b" is empty.',
      'text node "c" is empty.',
      'edge "e2" points at a node that does not exist; skipped.',
      'edge "e3" connects a node to itself; skipped.',
      'edge "e4" repeats an earlier edge between the same nodes; skipped.',
    ]);
    const board = applyToEmpty(result.ops);
    expect(Object.values(board.edges)[0]?.label).toHaveLength(120);
  });

  it('returns a warning, not an exception, for text that is not a canvas', () => {
    expect(fromJsonCanvas('not json').warnings[0]).toMatch(/not valid JSON/);
    expect(fromJsonCanvas('[1,2]').warnings[0]).toMatch(/not a JSON object/);
    expect(fromJsonCanvas('{}')).toEqual({
      ops: [],
      warnings: ['the canvas has no "nodes" list.'],
    });
  });

  it('keeps a title that ends in hashes', () => {
    const board = build([
      { op: 'add_node', node: { type: 'note', title: 'Use C#' } },
      { op: 'add_node', node: { type: 'note', title: 'Issue #' } },
    ]);
    const back = applyToEmpty(fromJsonCanvas(toJsonCanvas(board)).ops);
    expect(
      Object.values(back.nodes)
        .map((n) => n.title)
        .sort(),
    ).toEqual(['Issue #', 'Use C#']);
  });
});
