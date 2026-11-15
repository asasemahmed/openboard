import { describe, expect, it } from 'vitest';
import { applyOps } from '../apply.js';
import type { Op } from '../ops.js';
import { emptyBoard } from '../serialize.js';
import { ada, build, counter, HOSTILE, richBoard, T0, T1 } from './fixtures.test.js';
import { scriptJson, toHtml } from './html.js';
import { toSvg } from './svg.js';
import { DARK_THEME, LIGHT_THEME } from './svg-theme.js';

const EVIL = '</script><img src=x onerror=alert(1)><!-- \u2028 <svg onload=alert(2)>';

function hostileBoard() {
  return build(
    [
      { op: 'add_node', ref: 'f', node: { type: 'frame', title: `Frame ${EVIL}` } },
      {
        op: 'add_node',
        node: {
          type: 'task',
          title: EVIL,
          body: `Body ${EVIL}\n\nSee https://example.com/page and <b>bold</b>`,
          status: 'in_progress',
          tags: ['<i>tag</i>'],
          links: [{ kind: 'url', target: 'https://example.com/"><script>alert(3)</script>' }],
          parent: '$f',
        },
      },
      { op: 'add_node', node: { type: 'note', title: HOSTILE.quotes, body: HOSTILE.brackets } },
    ],
    { id: 'evil', name: `Board ${EVIL}` },
  );
}

/** The JSON in the cards script element, parsed. */
function cardsOf(html: string): Record<string, { title: string; body?: string; links?: string[] }> {
  const m = /<script type="application\/json" id="cards">([^<]*)<\/script>/.exec(html);
  if (!m) throw new Error('no cards element');
  return JSON.parse(m[1] as string);
}

/** The page without the card data, which is the only place board text may hold a URL. */
function withoutCards(html: string): string {
  return html.replace(/<script type="application\/json" id="cards">[^<]*<\/script>/, '');
}

/** The markup with all text between tags removed, so board text cannot pass for markup. */
function tagsOnly(html: string): string {
  return html.replace(/>[^<]*</g, '><');
}

describe('toHtml', () => {
  it('is deterministic', () => {
    expect(toHtml(richBoard())).toBe(toHtml(richBoard()));
    expect(toHtml(richBoard(), { theme: 'dark' })).toBe(toHtml(richBoard(), { theme: 'dark' }));
  });

  it('is one self-contained page with a strict policy', () => {
    const html = toHtml(hostileBoard());
    expect(html.startsWith('<!doctype html>\n')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`,
    );
    // Links in card text are kept, as text, in the card data only.
    expect(html).toContain('https://example.com/page');
    const page = withoutCards(html);
    expect(page.match(/<script\b/g)).toHaveLength(1);
    expect(page).not.toMatch(/@import|<link\b|<iframe|<object|<embed|<img/i);
    // Board text can show a URL, but no tag or attribute names one.
    const markup = tagsOnly(page);
    expect(markup).not.toMatch(/https?:\/\//);
    expect(markup).not.toMatch(/\s(src|href|xlink:href|srcset|action|poster|background)=/i);
    expect(markup).not.toMatch(/url\((?!#)/i);
  });

  it('keeps hostile titles and bodies inert', () => {
    const board = hostileBoard();
    const html = toHtml(board);
    // Only the page's own two scripts open and close.
    expect(html.match(/<script\b/g)).toHaveLength(2);
    expect(html.match(/<\/script/g)).toHaveLength(2);
    expect(html).not.toMatch(/<img|<!--|<svg onload|<b>|<i>/);
    // U+2028 is fine as HTML text, but not raw inside a script element.
    for (const script of html.match(/<script\b[^>]*>[^]*?<\/script>/g) ?? []) {
      expect(script).not.toContain('\u2028');
    }
    expect(tagsOnly(html)).not.toMatch(/\son\w+=/);
    // In the card data, the text survives exactly.
    const task = Object.values(board.nodes).find((node) => node.type === 'task');
    const cards = cardsOf(html);
    expect(cards[task?.id as string]).toMatchObject({
      title: EVIL,
      body: task?.body,
      links: ['url https://example.com/"><script>alert(3)</script>'],
    });
    // The script reads board text with textContent only.
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });

  it('escapes JSON for a script element', () => {
    const text = scriptJson({ a: '</script><!-- & \u2028\u2029 >' });
    expect(text).toBe('{"a":"\\u003c/script\\u003e\\u003c!-- \\u0026 \\u2028\\u2029 \\u003e"}');
    expect(JSON.parse(text)).toEqual({ a: '</script><!-- & \u2028\u2029 >' });
  });

  it('lists every card, not frames, with what the panel shows', () => {
    const board = richBoard();
    const cards = cardsOf(toHtml(board));
    const ids = Object.values(board.nodes)
      .filter((node) => node.type !== 'frame')
      .map((node) => node.id)
      .sort();
    expect(Object.keys(cards).sort()).toEqual(ids);
    for (const id of ids) expect(toHtml(board)).toContain(`data-id="${id}"`);
  });

  it('follows the system theme, or a forced one', () => {
    const board = richBoard();
    const auto = toHtml(board);
    expect(auto).toContain('<meta name="color-scheme" content="light dark">');
    expect(auto).toContain('@media (prefers-color-scheme: dark)');
    const [light, dark] = auto.split('@media (prefers-color-scheme: dark)') as [string, string];
    expect(light).toContain(`--canvas:${LIGHT_THEME.canvas}`);
    expect(dark).toContain(`--canvas:${DARK_THEME.canvas}`);

    const forcedLight = toHtml(board, { theme: 'light' });
    expect(forcedLight).toContain('<meta name="color-scheme" content="light">');
    expect(forcedLight).not.toContain('prefers-color-scheme');
    expect(forcedLight).not.toContain(DARK_THEME.canvas);
    const forcedDark = toHtml(board, { theme: 'dark' });
    expect(forcedDark).toContain('<meta name="color-scheme" content="dark">');
    expect(forcedDark).not.toContain('prefers-color-scheme');
    expect(forcedDark).toContain(`fill:${DARK_THEME.fills.task}`);
    expect(forcedDark).not.toContain(LIGHT_THEME.canvas);
  });

  it('gives every placeholder colour in the drawing a value in both themes', () => {
    const html = toHtml(richBoard());
    const [light, dark] = html.split('@media (prefers-color-scheme: dark)') as [string, string];
    const svg = html.slice(html.indexOf('<svg'), html.indexOf('</svg>'));
    const used = [...svg.matchAll(/\s([\w-]+)="(#0b[0-9a-f]{4}|0\.000\d+)"/g)];
    expect(used.length).toBeGreaterThan(20);
    for (const [, attr, token] of used) {
      expect(['fill', 'stroke', 'fill-opacity']).toContain(attr);
      expect(light).toContain(`[${attr}="${token}"]{`);
      expect(dark).toContain(`[${attr}="${token}"]{`);
    }
    // Real colours come only from the rules: the drawing itself has none.
    expect(svg).not.toContain(LIGHT_THEME.fills.task);
    expect(svg).not.toContain(DARK_THEME.fills.task);
  });

  it('renders an empty board', () => {
    const html = toHtml(build([]));
    expect(html).toContain('Empty board');
    expect(cardsOf(html)).toEqual({});
  });

  it('keeps a board of 3000 cards to a reasonable size', () => {
    const newId = counter('big');
    const ops: Op[] = [];
    for (let f = 0; f < 30; f++) {
      ops.push({ op: 'add_node', ref: `f${f}`, node: { type: 'frame', title: `Frame ${f}` } });
    }
    for (let i = 0; i < 3000; i++) {
      ops.push({
        op: 'add_node',
        node: {
          type: (['task', 'note', 'risk', 'question'] as const)[i % 4],
          title: `Card ${i} ${HOSTILE.quotes}`,
          body: 'A body of a couple of sentences, as cards usually have. '.repeat(3),
          status: i % 3 === 0 ? 'todo' : 'done',
          tags: ['a', 'b'],
          parent: `$f${i % 30}`,
        },
      });
    }
    const result = applyOps(emptyBoard({ id: 'big', name: 'Big' }, T0), ops, {
      actor: ada,
      now: T1,
      newId,
      maxOps: ops.length,
    });
    if (!result.ok) throw new Error('board failed');
    const start = performance.now();
    const html = toHtml(result.board);
    const elapsed = performance.now() - start;
    const svg = toSvg(result.board);
    // The board is drawn once, whatever the theme; the rest is the card data and the page.
    expect(html.length).toBeLessThan(svg.length * 1.4);
    expect(html.length / 3000).toBeLessThan(2000);
    expect(elapsed).toBeLessThan(3000);
    console.info(
      `toHtml: 3000 cards in ${elapsed.toFixed(0)} ms, ${(html.length / 1024 / 1024).toFixed(1)} MB`,
    );
  });
});
