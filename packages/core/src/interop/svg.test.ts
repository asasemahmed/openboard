import { describe, expect, it } from 'vitest';
import { applyOps } from '../apply.js';
import { diffBoards } from '../diff.js';
import type { Op } from '../ops.js';
import type { Board } from '../schema.js';
import { ada, build, counter, HOSTILE, richBoard, showcaseBoard, T1 } from './fixtures.test.js';
import { boardGeometry } from './layout.js';
import { toSvg } from './svg.js';
import { DARK_THEME, LIGHT_THEME } from './svg-theme.js';

/**
 * A minimal XML well-formedness check: tags balance, attribute values are
 * quoted, and text and attributes hold no raw `<` and no `&` outside an entity.
 */
function checkXml(xml: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  const entity = /^&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/;
  const checkText = (text: string, where: string) => {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '<') problems.push(`raw < in ${where}`);
      if (text[i] === '&' && !entity.test(text.slice(i)))
        problems.push(`raw & in ${where}: ${text.slice(i, i + 12)}`);
    }
  };
  let i = 0;
  while (i < xml.length) {
    const open = xml.indexOf('<', i);
    if (open === -1) {
      checkText(xml.slice(i), 'trailing text');
      break;
    }
    checkText(xml.slice(i, open), `text before offset ${open}`);
    const close = xml.indexOf('>', open);
    if (close === -1) {
      problems.push('unclosed tag');
      break;
    }
    // A '>' inside a quoted attribute value would end the tag early: find the real end.
    let end = open + 1;
    let quote: string | null = null;
    for (; end < xml.length; end++) {
      const c = xml[end];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    const tag = xml.slice(open + 1, end);
    i = end + 1;
    if (tag.startsWith('?') || tag.startsWith('!--')) continue;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      const top = stack.pop();
      if (top !== name) problems.push(`</${name}> closes <${top}>`);
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const name = /^([A-Za-z][\w:.-]*)/.exec(body)?.[1];
    if (!name) {
      problems.push(`bad tag <${tag.slice(0, 20)}>`);
      continue;
    }
    const attrs = body.slice(name.length);
    const attrRe = /\s+([A-Za-z_:][\w:.-]*)="([^"]*)"/y;
    let pos = 0;
    const seen = new Set<string>();
    while (pos < attrs.length) {
      attrRe.lastIndex = pos;
      const m = attrRe.exec(attrs);
      if (!m) {
        if (attrs.slice(pos).trim())
          problems.push(`bad attributes on <${name}>: ${attrs.slice(pos, pos + 30)}`);
        break;
      }
      if (seen.has(m[1] as string)) problems.push(`duplicate attribute ${m[1]} on <${name}>`);
      seen.add(m[1] as string);
      checkText(m[2] as string, `attribute ${m[1]}`);
      pos = attrRe.lastIndex;
    }
    if (!selfClosing) stack.push(name);
  }
  if (stack.length) problems.push(`unclosed: ${stack.join(', ')}`);
  return problems;
}

function viewBox(svg: string): [number, number, number, number] {
  const m = /viewBox="([^"]+)"/.exec(svg);
  return (m?.[1] ?? '').split(' ').map(Number) as [number, number, number, number];
}

describe('checkXml', () => {
  it('catches the problems it is meant to catch', () => {
    expect(checkXml('<a><b x="1"/></a>')).toEqual([]);
    expect(checkXml('<a><b></a>')).not.toEqual([]);
    expect(checkXml('<a>x & y</a>')).not.toEqual([]);
    expect(checkXml('<a x="<"/>')).not.toEqual([]);
    expect(checkXml('<a x=1/>')).not.toEqual([]);
  });
});

describe('toSvg', () => {
  it.each([
    ['todo', 'To do'],
    ['in_progress', 'In progress'],
    ['blocked', 'Blocked'],
    ['done', 'Done'],
    ['cancelled', 'Cancelled'],
  ] as const)('capitalises the %s status in both themes', (status, label) => {
    const board = build([{ op: 'add_node', node: { type: 'task', title: 'Example', status } }]);
    for (const theme of ['light', 'dark'] as const) {
      const svg = toSvg(board, { theme });
      expect(svg).toContain(`>${label}</text>`);
      expect(svg).not.toContain(`>${label.toLowerCase()}</text>`);
    }
  });

  it('produces a well-formed, self-contained document', () => {
    for (const theme of ['light', 'dark'] as const) {
      const svg = toSvg(richBoard(), { theme });
      expect(checkXml(svg)).toEqual([]);
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg).not.toMatch(
        /<script|<style|<image|<foreignObject|@import|href=|https?:\/\/(?!www\.w3\.org)/,
      );
      expect(svg).not.toMatch(/\son\w+=/);
    }
  });

  it('escapes hostile titles', () => {
    const svg = toSvg(richBoard());
    expect(svg).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(svg).toContain('He said &quot;ship it&quot; &amp; left');
    expect(svg).toContain('Checkout &lt;plan&gt; &amp; &quot;more&quot;');
    expect(svg).toContain('日本語');
    expect(svg).not.toContain('<b>');
    const control = build([{ op: 'add_node', node: { type: 'note', title: 'bell \u0007 and ￾' } }]);
    expect(checkXml(toSvg(control))).toEqual([]);
    expect(toSvg(control)).not.toMatch(/[\u0007￾]/);
  });

  it('fits the viewBox to the content plus padding and the header', () => {
    const board = showcaseBoard();
    const { bounds } = boardGeometry(board);
    const b = bounds as NonNullable<typeof bounds>;
    const [x, y, w, h] = viewBox(toSvg(board, { padding: 20, title: false }));
    expect([x, y, w, h]).toEqual([b.x - 20, b.y - 20, b.w + 40, b.h + 40]);
    const [, ty, , th] = viewBox(toSvg(board, { padding: 20 }));
    expect(ty).toBeLessThan(y);
    expect(th).toBeGreaterThan(h);
  });

  it('draws every card, frame and edge', () => {
    const board = showcaseBoard();
    const svg = toSvg(board);
    for (const id of Object.keys(board.nodes)) expect(svg).toContain(`data-id="${id}"`);
    expect(svg.match(/marker-end=/g)).toHaveLength(Object.keys(board.edges).length);
    expect(svg).toContain('>Task</text>');
    expect(svg).toContain('>In progress</text>');
    // Long titles wrap to two lines and are cut with an ellipsis when even that is too long.
    expect(svg).toContain('>Do we need 3-D Secure for</text>');
    const long = build([{ op: 'add_node', node: { type: 'note', title: 'word '.repeat(40) } }]);
    expect(toSvg(long)).toMatch(/word…<\/text>/);
  });

  it('prefixes ids so several pictures can share a page', () => {
    const a = toSvg(showcaseBoard());
    const b = toSvg(showcaseBoard(), { theme: 'dark' });
    const ids = (svg: string) => [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const shared = ids(a).filter((id) => ids(b).includes(id));
    expect(shared).toEqual([]);
    expect(toSvg(showcaseBoard(), { idPrefix: 'pr42' })).toContain('id="pr42-grid"');
  });

  it('uses the theme colours', () => {
    const light = toSvg(showcaseBoard());
    const dark = toSvg(showcaseBoard(), { theme: 'dark' });
    expect(light).toContain(`fill="${LIGHT_THEME.canvas}"`);
    expect(light).toContain(`fill="${LIGHT_THEME.types.task}"`);
    // A card is filled with its type's tint, and the glyph is drawn in the label colour.
    expect(light).toContain(`fill="${LIGHT_THEME.fills.task}"`);
    expect(light).toContain(`stroke="${LIGHT_THEME.types.task}"`);
    expect(dark).toContain(`fill="${DARK_THEME.fills.task}"`);
    expect(dark).toContain(`fill="${DARK_THEME.canvas}"`);
    expect(dark).toContain(`fill="${DARK_THEME.types.task}"`);
    expect(dark).not.toContain(LIGHT_THEME.canvas);
  });

  it('words a typed or named connection and leaves a plain one bare', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id, i) => ({
      op: 'add_node' as const,
      id: `n_${id}`,
      node: { type: 'note', title: `Card ${id}`, view: { x: i * 400, y: 0 } },
    }));
    const svg = toSvg(
      build([
        ...nodes,
        { op: 'add_edge', edge: { type: 'relates_to', source: 'n_a', target: 'n_b' } },
        { op: 'add_edge', edge: { type: 'blocks', source: 'n_b', target: 'n_c' } },
        {
          op: 'add_edge',
          edge: { type: 'relates_to', source: 'n_c', target: 'n_d', label: 'same team' },
        },
      ]),
    );
    expect(svg.match(/marker-end=/g)).toHaveLength(3);
    expect(svg).toContain('>blocks</text>');
    expect(svg).toContain('>same team</text>');
    expect(svg).not.toContain('>relates to</text>');
  });

  it('renders an empty board as a small placeholder', () => {
    const svg = toSvg(build([]));
    expect(checkXml(svg)).toEqual([]);
    expect(svg).toContain('>Empty board</text>');
    expect(viewBox(svg)).toEqual([0, 0, 360, 200]);
  });

  it('scales down to maxWidth without changing the viewBox', () => {
    const svg = toSvg(showcaseBoard(), { maxWidth: 600 });
    expect(svg).toMatch(/width="600"/);
    expect(viewBox(svg)[2]).toBeGreaterThan(600);
  });

  it('is deterministic', () => {
    expect(toSvg(richBoard(), { theme: 'dark' })).toBe(toSvg(richBoard(), { theme: 'dark' }));
  });

  it('draws a diff: added, removed, updated and moved items and a legend', () => {
    const before = showcaseBoard();
    const id = (title: string) =>
      Object.values(before.nodes).find((n) => n.title === title)?.id as string;
    const ops: Op[] = [
      {
        op: 'add_node',
        ref: 'n',
        node: { type: 'task', title: 'Refund flow', status: 'todo', view: { x: 1064, y: 360 } },
      },
      { op: 'add_edge', edge: { type: 'depends_on', source: '$n', target: id('Payment API') } },
      { op: 'remove_node', id: id('Use Stripe') },
      {
        op: 'update_node',
        id: id('Retry logic'),
        patch: { title: 'Retry with backoff', status: 'done' },
      },
      { op: 'move_node', id: id('Review agent'), view: { x: 376, y: -240 } },
    ];
    const result = applyOps(before, ops, {
      actor: ada,
      now: new Date(T1.getTime() + 1000),
      newId: counter('d'),
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const after = result.board;
    const diff = diffBoards(before, after);
    const svg = toSvg(after, { diff, before });
    expect(checkXml(svg)).toEqual([]);
    // Added: green outline and a badge.
    expect(svg).toContain(`stroke="${LIGHT_THEME.diff.added}" stroke-width="2"`);
    // Removed: drawn where it was, dashed red, title struck.
    expect(svg).toContain('>Use Stripe</text>');
    expect(svg).toMatch(
      new RegExp(`stroke="${LIGHT_THEME.diff.removed}" stroke-width="1.75" stroke-dasharray`),
    );
    // Updated: amber, with the fields that changed.
    expect(svg).toContain('>status, title</text>');
    expect(svg).toContain('>moved</text>');
    // Legend.
    expect(svg).toContain('>2 added</text>');
    expect(svg).toContain('>1 removed</text>');
    expect(svg).toContain('>1 changed</text>');
    expect(svg).toContain('>1 moved</text>');
    // Without the board before, removed nodes are still drawn, from the diff.
    expect(toSvg(after, { diff })).toContain('>Use Stripe</text>');
    expect(toSvg(after, { diff, theme: 'dark' })).toContain(DARK_THEME.diff.updated);
  });

  it('renders 500 nodes well under a second', () => {
    let board: Board = build([]);
    const ops: Op[] = [];
    for (let f = 0; f < 10; f++) {
      ops.push({ op: 'add_node', ref: `f${f}`, node: { type: 'frame', title: `Frame ${f}` } });
    }
    for (let i = 0; i < 490; i++) {
      ops.push({
        op: 'add_node',
        ref: `n${i}`,
        node: {
          type: (['task', 'note', 'risk', 'question'] as const)[i % 4],
          title: `Node ${i} ${HOSTILE.quotes}`,
          body: 'Some body text that is long enough to need cutting on the card.',
          status: i % 3 === 0 ? 'todo' : 'done',
          tags: ['a', 'b', 'c'],
          parent: `$f${i % 10}`,
        },
      });
    }
    board = build(ops);
    const edgeOps: Op[] = [];
    const ids = Object.values(board.nodes)
      .filter((n) => n.type !== 'frame')
      .map((n) => n.id);
    for (let i = 0; i + 7 < ids.length; i++) {
      edgeOps.push({
        op: 'add_edge',
        edge: {
          type: i % 2 ? 'depends_on' : 'relates_to',
          source: ids[i] as string,
          target: ids[i + 7] as string,
        },
      });
    }
    const withEdges = applyOps(board, edgeOps, { actor: ada, now: T1, newId: counter('e') });
    if (!withEdges.ok) throw new Error('edges failed');
    const start = performance.now();
    const svg = toSvg(withEdges.board);
    const elapsed = performance.now() - start;
    expect(checkXml(svg)).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
    console.info(
      `toSvg: 500 nodes, ${edgeOps.length} edges in ${elapsed.toFixed(0)} ms, ${(svg.length / 1024).toFixed(0)} KB`,
    );
  });
});
