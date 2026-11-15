/**
 * A board as one HTML page that opens in any browser, with nothing to install
 * and nothing fetched: the SVG picture, inline, with a small script to pan and
 * zoom it and to open a card's full title and body in a side panel. It is a
 * view only; nothing on the page changes the board.
 *
 * The picture is drawn once with placeholder colours, and the page's CSS fills
 * them in for the light or the dark theme, so following the system theme does
 * not mean drawing the board twice.
 *
 * Board text is untrusted. In the drawing it is escaped as XML; the cards'
 * data is JSON with `<`, `>`, `&`, U+2028 and U+2029 escaped, so it cannot end
 * its script element; and the script puts text on the page with `textContent`
 * only. A Content-Security-Policy that allows no fetches at all backs this up.
 */
import type { Board, BoardNode, Link } from '../schema.js';
import { compareStrings } from '../util.js';
import { toSvg } from './svg.js';
import {
  DARK_THEME,
  LIGHT_THEME,
  SVG_FONT_MONO,
  SVG_FONT_SANS,
  type SvgTheme,
} from './svg-theme.js';
import { STATUS_WORDS, typeWords, xmlEscape } from './text.js';

export interface HtmlOptions {
  /** Force a theme. By default the page follows the system's light or dark setting. */
  theme?: 'light' | 'dark';
}

/** What the side panel shows for one card. */
interface CardData {
  type: string;
  title: string;
  body?: string;
  status?: string;
  tags?: string[];
  links?: string[];
}

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** The board as a self-contained, view-only HTML page. */
export function toHtml(board: Board, options: HtmlOptions = {}): string {
  const { palette, placeholders } = placeholderTheme();
  const svg = toSvg(board, { palette })
    .trimEnd()
    // Inline SVG in HTML needs no namespace, and the page then names no URL at all.
    .replace(' xmlns="http://www.w3.org/2000/svg"', '');
  const scheme = options.theme ?? 'light dark';
  const used = usedPlaceholders(svg);
  const light = `:root{${pageColours(LIGHT_THEME)}}\n${themeRules(placeholders, used, 'light')}`;
  const dark = `:root{${pageColours(DARK_THEME)}}\n${themeRules(placeholders, used, 'dark')}`;
  let colours: string;
  if (options.theme === 'light') colours = light;
  else if (options.theme === 'dark') colours = dark;
  else colours = `${light}\n@media (prefers-color-scheme: dark) {\n${dark}\n}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${scheme}">
<title>${xmlEscape(board.name)}</title>
<style>
${colours}
${STYLE}
</style>
</head>
<body>
<main id="view">
<div id="stage">
${svg}
</div>
</main>
<div id="controls" role="toolbar" aria-label="Zoom">
<button type="button" data-zoom="out" aria-label="Zoom out" title="Zoom out (-)">&#8722;</button>
<button type="button" data-zoom="in" aria-label="Zoom in" title="Zoom in (+)">+</button>
<button type="button" data-zoom="fit" title="Fit the board (0)">Fit</button>
</div>
<aside id="panel" tabindex="-1" aria-labelledby="panel-title" hidden>
<button type="button" id="close" aria-label="Close" title="Close (Esc)">&#215;</button>
<p class="type"></p>
<h2 id="panel-title"></h2>
<p class="meta"></p>
<div class="body"></div>
<ul class="links"></ul>
</aside>
<script type="application/json" id="cards">${scriptJson(cardData(board))}</script>
<script>
${SCRIPT}
</script>
</body>
</html>
`;
}

/**
 * JSON that is safe inside a `<script>` element: `<`, `>` and `&` are escaped
 * so that `</script>` and `<!--` cannot appear, and U+2028 and U+2029 so that
 * old parsers read it as JavaScript too.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function cardData(board: Board): Record<string, CardData> {
  const out: Record<string, CardData> = {};
  const cards = Object.values(board.nodes)
    .filter((node) => node.type !== 'frame')
    .sort((a, b) => compareStrings(a.id, b.id));
  for (const node of cards) out[node.id] = card(node);
  return out;
}

function card(node: BoardNode): CardData {
  const words = typeWords(node.type);
  const data: CardData = {
    type: words.charAt(0).toUpperCase() + words.slice(1),
    title: node.title,
  };
  if (node.body) data.body = node.body;
  if (node.status) {
    const status = STATUS_WORDS[node.status];
    data.status = status.charAt(0).toUpperCase() + status.slice(1);
  }
  if (node.tags?.length) data.tags = node.tags;
  if (node.links?.length) data.links = node.links.map(linkText);
  return data;
}

/** A link as plain text: `file src/a.ts:4-6`, `url https://example.com`. */
function linkText(link: Link): string {
  let text = `${link.kind} ${link.target}`;
  if (link.line !== undefined) text += `:${link.line}`;
  if (link.endLine !== undefined) text += `-${link.endLine}`;
  return link.stale ? `${text} (stale)` : text;
}

// ── Colours ──────────────────────────────────────────────────────────────────

interface Placeholder {
  token: string;
  /** The attributes it is used in. */
  attrs: string[];
  light: string;
  dark: string;
}

/**
 * A theme whose every colour and opacity is a placeholder no real drawing
 * uses (`#0b0000`, `#0b0001`, ...; `0.0001`, `0.000101`, ...), and what each
 * one stands for in the light and the dark theme.
 */
function placeholderTheme(): { palette: SvgTheme; placeholders: Placeholder[] } {
  const placeholders: Placeholder[] = [];
  const walk = (light: unknown, dark: unknown): unknown => {
    if (typeof light === 'object' && light !== null) {
      const other = dark as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(light).map(([key, value]) => [key, walk(value, other[key])]),
      );
    }
    const i = placeholders.length;
    if (typeof light === 'number') {
      const token = Number(`0.000${100 + i}`);
      placeholders.push({
        token: String(token),
        attrs: ['fill-opacity'],
        light: String(light),
        dark: String(dark),
      });
      return token;
    }
    const token = `#0b${i.toString(16).padStart(4, '0')}`;
    placeholders.push({
      token,
      attrs: ['fill', 'stroke'],
      light: String(light),
      dark: String(dark),
    });
    return token;
  };
  return { palette: walk(LIGHT_THEME, DARK_THEME) as SvgTheme, placeholders };
}

/** Every `attr="value"` pair the drawing has, to write rules only for those. */
function usedPlaceholders(svg: string): Set<string> {
  const used = new Set<string>();
  for (const match of svg.matchAll(/\s(fill|stroke|fill-opacity)="(#0b[0-9a-f]{4}|0\.000\d+)"/g)) {
    used.add(`${match[1]}=${match[2]}`);
  }
  return used;
}

/** CSS that gives each placeholder the theme's value; CSS outranks SVG attributes. */
function themeRules(
  placeholders: readonly Placeholder[],
  used: ReadonlySet<string>,
  theme: 'light' | 'dark',
): string {
  const rules: string[] = [];
  for (const placeholder of placeholders) {
    for (const attr of placeholder.attrs) {
      if (!used.has(`${attr}=${placeholder.token}`)) continue;
      rules.push(`[${attr}="${placeholder.token}"]{${attr}:${placeholder[theme]}}`);
    }
  }
  return rules.join('\n');
}

/** The colours of the page around the picture: background, panel and buttons. */
function pageColours(theme: SvgTheme): string {
  return [
    `--canvas:${theme.canvas}`,
    `--card:${theme.card}`,
    `--sunken:${theme.sunken}`,
    `--line:${theme.line}`,
    `--ink:${theme.ink}`,
    `--ink2:${theme.ink2}`,
    `--accent:${theme.accent}`,
  ].join(';');
}

// ── Page ─────────────────────────────────────────────────────────────────────

const STYLE = `html,body{margin:0;height:100%}
body{background:var(--canvas);color:var(--ink);font:14px/1.5 ${SVG_FONT_SANS};overflow:hidden}
#view{position:fixed;inset:0;overflow:hidden;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}
#view.dragging{cursor:grabbing}
#stage{position:absolute;left:0;top:0;transform-origin:0 0}
#stage svg{display:block}
#stage g[tabindex]{cursor:pointer;outline:none}
#stage g[tabindex]:focus-visible>rect:first-of-type,#stage g.open>rect:first-of-type{stroke:var(--accent);stroke-width:3px}
button{font:inherit;color:inherit;cursor:pointer}
button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
#controls{position:fixed;right:16px;bottom:16px;display:flex;gap:2px;padding:4px;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 2px 8px rgb(0 0 0/.12)}
#controls button{min-width:34px;height:32px;padding:0 8px;border:0;border-radius:7px;background:none;font-size:15px}
#controls button:hover{background:var(--sunken)}
body:has(#panel:not([hidden])) #controls{right:calc(min(420px,100vw) + 16px)}
#panel{position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);box-sizing:border-box;overflow:auto;padding:20px 24px 32px;background:var(--card);border-left:1px solid var(--line);box-shadow:-4px 0 16px rgb(0 0 0/.1);outline:none}
#panel[hidden]{display:none}
#close{position:absolute;top:12px;right:12px;width:32px;height:32px;border:0;border-radius:7px;background:none;font-size:20px;line-height:1}
#close:hover{background:var(--sunken)}
#panel .type{margin:0 40px 4px 0;color:var(--ink2);font-size:12px;font-weight:600}
#panel h2{margin:0 32px 8px 0;font-size:18px;line-height:1.3;overflow-wrap:anywhere}
#panel .meta{margin:0 0 16px;color:var(--ink2)}
#panel .meta:empty{display:none}
#panel .body{margin:0 0 16px;white-space:pre-wrap;overflow-wrap:anywhere}
#panel .links{margin:0;padding-left:18px;color:var(--ink2);font:12px/1.6 ${SVG_FONT_MONO};overflow-wrap:anywhere}`;

/**
 * Pan by dragging, zoom with the wheel, a pinch or the buttons, open a card by
 * clicking it or with Enter. The view covers the whole window, so pointer
 * positions are view positions.
 */
const SCRIPT = `(() => {
  'use strict';
  const cards = new Map(Object.entries(JSON.parse(document.getElementById('cards').textContent)));
  const view = document.getElementById('view');
  const stage = document.getElementById('stage');
  const svg = stage.querySelector('svg');
  const panel = document.getElementById('panel');
  const width = svg.width.baseVal.value;
  const height = svg.height.baseVal.value;
  let x = 0;
  let y = 0;
  let k = 1;
  let open = null;

  const draw = () => {
    stage.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + k + ')';
  };
  const zoomAt = (px, py, factor) => {
    const next = Math.min(4, Math.max(0.02, k * factor));
    x = px - ((px - x) * next) / k;
    y = py - ((py - y) * next) / k;
    k = next;
    draw();
  };
  const zoom = (factor) => zoomAt(view.clientWidth / 2, view.clientHeight / 2, factor);
  const fit = () => {
    const w = view.clientWidth;
    const h = view.clientHeight;
    k = Math.max(0.02, Math.min(1, (w - 48) / width, (h - 48) / height));
    x = (w - width * k) / 2;
    y = (h - height * k) / 2;
    draw();
  };

  // Cards can be reached with Tab and opened with Enter.
  svg.setAttribute('role', 'group');
  for (const g of svg.querySelectorAll('g[data-id]')) {
    const card = cards.get(g.getAttribute('data-id'));
    if (!card) continue;
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', card.type + ': ' + card.title);
  }

  const show = (g) => {
    const card = cards.get(g.getAttribute('data-id'));
    if (open) open.classList.remove('open');
    open = g;
    g.classList.add('open');
    panel.querySelector('.type').textContent = card.type;
    panel.querySelector('h2').textContent = card.title;
    panel.querySelector('.meta').textContent = [card.status, (card.tags || []).join(', ')]
      .filter(Boolean)
      .join(' · ');
    panel.querySelector('.body').textContent = card.body || '';
    panel.querySelector('.links').replaceChildren(
      ...(card.links || []).map((link) => {
        const item = document.createElement('li');
        item.textContent = link;
        return item;
      }),
    );
    panel.hidden = false;
    panel.scrollTop = 0;
    panel.focus();
  };
  const hide = () => {
    panel.hidden = true;
    if (!open) return;
    open.classList.remove('open');
    open.focus({ preventScroll: true });
    open = null;
  };

  // Keep a focused card on screen, and clear of the panel.
  const reveal = (g) => {
    const r = g.getBoundingClientRect();
    const right = panel.hidden ? view.clientWidth : panel.getBoundingClientRect().left;
    if (r.left >= 0 && r.top >= 0 && r.right <= right && r.bottom <= view.clientHeight) return;
    x += right / 2 - (r.left + r.right) / 2;
    y += view.clientHeight / 2 - (r.top + r.bottom) / 2;
    draw();
  };
  // Focus would scroll the view on its own; the transform does that instead.
  view.addEventListener('scroll', () => {
    view.scrollLeft = 0;
    view.scrollTop = 0;
  });
  view.addEventListener('focusin', (e) => {
    const g = e.target.closest('g[tabindex]');
    if (g) reveal(g);
  });

  const pointers = new Map();
  let press = null;
  view.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    view.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    press = pointers.size === 1 ? { x: e.clientX, y: e.clientY, card: e.target.closest('g[tabindex]') } : null;
    view.classList.add('dragging');
  });
  view.addEventListener('pointermove', (e) => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    if (pointers.size === 2) {
      const [a, b] = pointers.values();
      const before = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [c, d] = pointers.values();
      const mid = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
      x += mid.x - before.x;
      y += mid.y - before.y;
      zoomAt(mid.x, mid.y, Math.hypot(c.x - d.x, c.y - d.y) / (before.d || 1));
    } else {
      x += e.clientX - last.x;
      y += e.clientY - last.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      draw();
    }
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) press = null;
  });
  const release = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 0) view.classList.remove('dragging');
    if (e.type === 'pointerup' && press) {
      if (press.card) show(press.card);
      else if (!panel.hidden) hide();
    }
    press = null;
  };
  view.addEventListener('pointerup', release);
  view.addEventListener('pointercancel', release);

  view.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      // A trackpad pinch arrives as a wheel event with ctrlKey, in smaller steps.
      zoomAt(e.clientX, e.clientY, Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.002)));
    },
    { passive: false },
  );
  // Safari reports a trackpad pinch as gesture events instead.
  let gestureFrom = 1;
  view.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    gestureFrom = k;
  });
  view.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, (gestureFrom * e.scale) / k);
  });

  document.getElementById('controls').addEventListener('click', (e) => {
    const action = e.target.closest('button')?.getAttribute('data-zoom');
    if (action === 'in') zoom(1.25);
    else if (action === 'out') zoom(0.8);
    else if (action === 'fit') fit();
  });
  document.getElementById('close').addEventListener('click', hide);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) return hide();
    if (e.ctrlKey || e.metaKey || e.altKey || panel.contains(e.target)) return;
    const card = e.target.closest && e.target.closest('g[tabindex]');
    if (card && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      show(card);
    } else if (e.key === '+' || e.key === '=') zoom(1.25);
    else if (e.key === '-') zoom(0.8);
    else if (e.key === '0') fit();
  });

  fit();
})();`;
