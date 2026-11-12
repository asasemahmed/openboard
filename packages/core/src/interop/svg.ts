/**
 * A static picture of a board: one self-contained SVG with no fonts, images,
 * scripts or CSS, drawn in the canvas's visual language. Frames are soft
 * regions with a title; cards are filled with a tint of their type's colour
 * and carry the type's glyph and name, a title of at most two lines, a
 * one-line body preview and a status chip; edges run between the facing sides
 * of their cards with an arrowhead and, unless they are plain, a small label.
 * Unlike the canvas, which can hold connections back until asked, a picture
 * draws every one.
 *
 * With `diff` the picture becomes a review aid: added items are outlined green
 * with a `+` badge, removed ones are drawn from the board before the change,
 * dashed red with a struck title, updated ones amber with the names of the
 * fields that changed, moved ones carry a small marker, and a legend counts
 * them.
 *
 * Text is measured approximately (there is no DOM), erring on the side of
 * wrapping and cutting early.
 */
import type { BoardDiff } from '../diff.js';
import type { Board, BoardEdge, BoardNode } from '../schema.js';
import { builtinTypeGlyph } from '../type-glyphs.js';
import { BOOKKEEPING_FIELDS, compareStrings } from '../util.js';
import { boardGeometry, facingSides, type Rect, sidePoint, union } from './layout.js';
import {
  DARK_THEME,
  LIGHT_THEME,
  SVG_FONT_MONO,
  SVG_FONT_SANS,
  type SvgTheme,
} from './svg-theme.js';
import {
  type FontSpec,
  measureText,
  plainText,
  STATUS_WORDS,
  truncateToWidth,
  typeWords,
  wrapText,
  xmlEscape,
} from './text.js';

export interface SvgOptions {
  theme?: 'light' | 'dark';
  /** Space around the content, in px. Default 32. */
  padding?: number;
  /** Draw the changes from `before` to `board`. */
  diff?: BoardDiff;
  /** The board before the change, for drawing what `diff` removed where it was. */
  before?: Board;
  /** Draw the board name above the content. Default true. */
  title?: boolean;
  /** Scale the picture down so it is at most this wide (the viewBox is unchanged). */
  maxWidth?: number;
  /** Prefix for ids inside the SVG. Defaults to one derived from the board. */
  idPrefix?: string;
}

const FONT_TYPE: FontSpec = { size: 12, bold: true };
const FONT_TITLE: FontSpec = { size: 15, bold: true };
const FONT_BODY: FontSpec = { size: 13 };
const FONT_PILL: FontSpec = { size: 11.5, bold: true };
const FONT_TAG: FontSpec = { size: 11.5 };
const FONT_FRAME: FontSpec = { size: 14, bold: true };
const FONT_EDGE: FontSpec = { size: 10.5, bold: true };
const FONT_NOTE: FontSpec = { size: 10, mono: true };
const FONT_BOARD: FontSpec = { size: 18, bold: true };
const FONT_LEGEND: FontSpec = { size: 12 };

const CARD_PAD_X = 14;
const HEADER_H = 44;
const MAX_TAGS = 2;

type Mark = 'added' | 'removed' | 'updated' | undefined;

interface EdgeStyle {
  color: string;
  width: number;
  dash?: string;
  marker: string;
}

/** Numbers with at most one decimal, so the output stays small. */
function n(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** A small stable hash for default id prefixes (FNV-1a, base 36). */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** The type's name as the canvas shows it: "Task", "Design review". */
function typeLabel(type: string): string {
  const words = typeWords(type);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The type's glyph, 14px, with its top-left corner at (x, y). */
function typeGlyph(type: string, x: number, y: number, color: string): string {
  const glyph = builtinTypeGlyph(type);
  if (!glyph) return `<circle cx="${n(x + 7)}" cy="${n(y + 7)}" r="3.5" fill="${color}"/>`;
  const drawing = glyph
    .map(({ tag, attrs }) => {
      const attributes = Object.entries(attrs)
        .map(([name, value]) => `${name}="${xmlEscape(value)}"`)
        .join(' ');
      return `<${tag} ${attributes}/>`;
    })
    .join('');
  return `<g transform="translate(${n(x)} ${n(y)}) scale(0.875)" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${drawing}</g>`;
}

function text(
  x: number,
  y: number,
  content: string,
  attrs: string,
  font: FontSpec,
  fontFamily?: string,
): string {
  const family = fontFamily ? ` font-family="${fontFamily}"` : '';
  const size = ` font-size="${font.size}"`;
  const weight = font.bold ? ' font-weight="600"' : '';
  const spacing = font.letterSpacing ? ` letter-spacing="${font.letterSpacing}"` : '';
  return `<text x="${n(x)}" y="${n(y)}"${family}${size}${weight}${spacing} ${attrs}>${xmlEscape(content)}</text>`;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// ── Edge routing ─────────────────────────────────────────────────────────────

type Point = { x: number; y: number };

/**
 * An orthogonal route between the facing sides of two rectangles: straight
 * when they overlap on the other axis, otherwise one elbow in the middle.
 */
function route(from: Rect, to: Rect): Point[] {
  const sides = facingSides(from, to);
  const horizontal = sides.from === 'left' || sides.from === 'right';
  if (horizontal) {
    const top = Math.max(from.y, to.y);
    const bottom = Math.min(from.y + from.h, to.y + to.h);
    const x1 = sidePoint(from, sides.from).x;
    const x2 = sidePoint(to, sides.to).x;
    if (bottom - top >= 16) {
      const y = (top + bottom) / 2;
      return [
        { x: x1, y },
        { x: x2, y },
      ];
    }
    const a = sidePoint(from, sides.from);
    const b = sidePoint(to, sides.to);
    const mid = (a.x + b.x) / 2;
    return [a, { x: mid, y: a.y }, { x: mid, y: b.y }, b];
  }
  const left = Math.max(from.x, to.x);
  const right = Math.min(from.x + from.w, to.x + to.w);
  const y1 = sidePoint(from, sides.from).y;
  const y2 = sidePoint(to, sides.to).y;
  if (right - left >= 16) {
    const x = (left + right) / 2;
    return [
      { x, y: y1 },
      { x, y: y2 },
    ];
  }
  const a = sidePoint(from, sides.from);
  const b = sidePoint(to, sides.to);
  const mid = (a.y + b.y) / 2;
  return [a, { x: a.x, y: mid }, { x: b.x, y: mid }, b];
}

/** Shorten the last segment a little, so the arrowhead's tip meets the card's border. */
function trimEnd(points: Point[], by: number): Point[] {
  const out = points.map((p) => ({ ...p }));
  const last = out[out.length - 1] as Point;
  const prev = out[out.length - 2] as Point;
  const len = Math.hypot(last.x - prev.x, last.y - prev.y);
  if (len > by * 2) {
    last.x -= ((last.x - prev.x) / len) * by;
    last.y -= ((last.y - prev.y) / len) * by;
  }
  return out;
}

/** SVG path data through `points` with rounded corners. */
function pathData(points: Point[], radius = 8): string {
  const first = points[0] as Point;
  let d = `M${n(first.x)} ${n(first.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1] as Point;
    const corner = points[i] as Point;
    const next = points[i + 1] as Point;
    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.5) {
      d += `L${n(corner.x)} ${n(corner.y)}`;
      continue;
    }
    const ax = corner.x - ((corner.x - prev.x) / inLen) * r;
    const ay = corner.y - ((corner.y - prev.y) / inLen) * r;
    const bx = corner.x + ((next.x - corner.x) / outLen) * r;
    const by = corner.y + ((next.y - corner.y) / outLen) * r;
    d += `L${n(ax)} ${n(ay)}Q${n(corner.x)} ${n(corner.y)} ${n(bx)} ${n(by)}`;
  }
  const last = points[points.length - 1] as Point;
  return `${d}L${n(last.x)} ${n(last.y)}`;
}

/** The point at fraction `t` of the polyline's length. */
function pointAt(points: Point[], t: number): Point {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  let goal = total * t;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (goal <= len && len > 0) {
      return { x: a.x + ((b.x - a.x) * goal) / len, y: a.y + ((b.y - a.y) * goal) / len };
    }
    goal -= len;
  }
  return { ...(points[points.length - 1] as Point) };
}

// ── Rendering ────────────────────────────────────────────────────────────────

interface DiffMarks {
  nodes: Map<string, Mark>;
  edges: Map<string, Mark>;
  fields: Map<string, string[]>;
  moved: Set<string>;
  removedNodes: BoardNode[];
  removedEdges: BoardEdge[];
  removedRects: Map<string, Rect>;
}

function diffMarks(board: Board, diff: BoardDiff, before: Board | undefined): DiffMarks {
  const nodes = new Map<string, Mark>();
  const edges = new Map<string, Mark>();
  const fields = new Map<string, string[]>();
  for (const node of diff.nodes.added) nodes.set(node.id, 'added');
  for (const update of diff.nodes.updated) {
    nodes.set(update.id, 'updated');
    fields.set(
      update.id,
      update.fields.filter((field) => !BOOKKEEPING_FIELDS.has(field)),
    );
  }
  for (const edge of diff.edges.added) edges.set(edge.id, 'added');
  for (const update of diff.edges.updated) {
    edges.set(update.id, 'updated');
  }
  const moved = new Set(diff.nodes.moved.map((move) => move.id));
  const removedNodes = diff.nodes.removed
    .map((node) => before?.nodes[node.id] ?? node)
    .filter((node) => !board.nodes[node.id]);
  const removedEdges = diff.edges.removed.filter((edge) => !board.edges[edge.id]);

  // Where removed nodes were: from the board before the change when given,
  // otherwise from the current board with the removed nodes put back.
  let source: Board;
  if (before) source = before;
  else {
    const restored: Record<string, BoardNode> = { ...board.nodes };
    for (const node of removedNodes) restored[node.id] = node;
    source = { ...board, nodes: restored };
  }
  const geometry = boardGeometry(source);
  const removedRects = new Map<string, Rect>();
  for (const node of removedNodes) {
    const rect = geometry.rects.get(node.id);
    if (rect) removedRects.set(node.id, rect);
  }
  return { nodes, edges, fields, moved, removedNodes, removedEdges, removedRects };
}

/** The board as a self-contained SVG document. */
export function toSvg(board: Board, options: SvgOptions = {}): string {
  const theme = options.theme === 'dark' ? DARK_THEME : LIGHT_THEME;
  const padding = Math.max(0, options.padding ?? 32);
  const showTitle = options.title ?? true;
  const prefix =
    options.idPrefix?.replace(/[^A-Za-z0-9_-]/g, '') ||
    `ob${hash(`${board.id}|${board.updatedAt}|${options.theme ?? 'light'}|${options.diff ? 'diff' : ''}`)}`;

  const { rects, depth } = boardGeometry(board);
  const marks = options.diff ? diffMarks(board, options.diff, options.before) : undefined;

  let content: Rect | null = null;
  for (const rect of rects.values()) content = union(content, rect);
  for (const rect of marks?.removedRects.values() ?? []) content = union(content, rect);

  const legend = marks ? legendItems(options.diff as BoardDiff, theme) : [];
  const hasHeader = showTitle || legend.length > 0;

  if (!content) return emptySvg(board, theme, showTitle, prefix, options.maxWidth);

  // ── Frame of the picture ──
  const legendWidth = legend.reduce((sum, item) => sum + item.width, 0);
  const titleWidth = showTitle ? measureText(board.name, FONT_BOARD) : 0;
  const headerTwoRows =
    showTitle && legend.length > 0 && titleWidth + 24 + legendWidth > Math.max(content.w, 480);
  const headerH = hasHeader ? (headerTwoRows ? HEADER_H + 24 : HEADER_H) : 0;
  const innerW = Math.max(content.w, hasHeader ? Math.min(titleWidth, 600) : 0, legendWidth);
  const vx = content.x - padding;
  const vy = content.y - headerH - padding;
  const vw = innerW + padding * 2;
  const vh = content.h + headerH + padding * 2;
  const scale =
    options.maxWidth && options.maxWidth > 0 && vw > options.maxWidth ? options.maxWidth / vw : 1;

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(vx)} ${n(vy)} ${n(vw)} ${n(vh)}" width="${n(vw * scale)}" height="${n(vh * scale)}" role="img" aria-labelledby="${prefix}-title" font-family="${SVG_FONT_SANS}">`,
    `<title id="${prefix}-title">${xmlEscape(board.name)}</title>`,
    defs(prefix, theme),
    `<rect x="${n(vx)}" y="${n(vy)}" width="${n(vw)}" height="${n(vh)}" fill="${theme.canvas}"/>`,
    `<rect x="${n(vx)}" y="${n(vy)}" width="${n(vw)}" height="${n(vh)}" fill="url(#${prefix}-grid)"/>`,
  );

  // ── Header: board name and legend ──
  if (hasHeader) {
    const top = content.y - headerH;
    if (showTitle) {
      out.push(
        text(
          content.x,
          top + 22,
          truncateToWidth(board.name, Math.max(innerW, 200), FONT_BOARD),
          `fill="${theme.ink}"`,
          FONT_BOARD,
        ),
      );
    }
    if (legend.length > 0) {
      let x = headerTwoRows || !showTitle ? content.x : content.x + innerW - legendWidth;
      const y = headerTwoRows ? top + 46 : top + 18;
      for (const item of legend) {
        out.push(
          `<rect x="${n(x)}" y="${n(y - 9)}" width="10" height="10" rx="3" fill="${item.color}"/>`,
          text(x + 15, y, item.label, `fill="${theme.ink2}"`, FONT_LEGEND),
        );
        x += item.width;
      }
    }
  }

  // ── Frames, outer first ──
  const frames = Object.values(board.nodes)
    .filter((node) => node.type === 'frame' && rects.has(node.id))
    .sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || compareStrings(a.id, b.id));
  out.push('<g>');
  for (const node of marks?.removedNodes ?? []) {
    const rect = marks?.removedRects.get(node.id);
    if (node.type === 'frame' && rect) out.push(frameSvg(node, rect, theme, 'removed', marks));
  }
  for (const frame of frames) {
    out.push(
      frameSvg(frame, rects.get(frame.id) as Rect, theme, marks?.nodes.get(frame.id), marks),
    );
  }
  out.push('</g>');

  // ── Edges, under the cards ──
  const cardRects: Rect[] = [];
  for (const node of Object.values(board.nodes)) {
    if (node.type !== 'frame') cardRects.push(rects.get(node.id) as Rect);
  }
  for (const node of marks?.removedNodes ?? []) {
    const rect = marks?.removedRects.get(node.id);
    if (node.type !== 'frame' && rect) cardRects.push(rect);
  }
  // Frame titles are text too: keep edge labels off them.
  for (const frame of frames) {
    const rect = rects.get(frame.id) as Rect;
    cardRects.push({
      x: rect.x + 8,
      y: rect.y + 6,
      w: Math.min(rect.w - 16, measureText(frame.title, FONT_FRAME) + 16),
      h: 28,
    });
  }
  const labels: string[] = [];
  const placedLabels: Rect[] = [];
  const rectOf = (id: string) => rects.get(id) ?? marks?.removedRects.get(id);

  const drawEdge = (edge: BoardEdge, mark: Mark) => {
    const from = rectOf(edge.source);
    const to = rectOf(edge.target);
    if (!from || !to || edge.source === edge.target) return;
    const style = edgeStyle(edge.type, theme, mark);
    const points = route(from, to);
    const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : '';
    out.push(
      `<path d="${pathData(trimEnd(points, 1.5))}" fill="none" stroke="${style.color}" stroke-width="${style.width}"${dash} stroke-linecap="round" stroke-linejoin="round" marker-end="url(#${prefix}-${style.marker})"/>`,
    );
    // A plain line says "these belong together" on its own, as on the canvas.
    const named = edge.label?.trim();
    if (!named && edge.type === 'relates_to' && !mark) return;
    const label = truncateToWidth(named ? named : typeWords(edge.type), 180, FONT_EDGE);
    const w = measureText(label, FONT_EDGE) + 14;
    const h = 16;
    for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      const at = pointAt(points, t);
      const box = { x: at.x - w / 2, y: at.y - h / 2, w, h };
      if (cardRects.some((rect) => intersects(rect, box))) continue;
      if (placedLabels.some((rect) => intersects(rect, box))) continue;
      placedLabels.push(box);
      const color = mark ? style.color : theme.ink2;
      labels.push(
        `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(w)}" height="${h}" rx="8" fill="${theme.canvas}" fill-opacity="0.92"/>`,
        text(at.x, at.y + 3.5, label, `text-anchor="middle" fill="${color}"`, FONT_EDGE),
      );
      break;
    }
  };

  out.push('<g>');
  for (const edge of marks?.removedEdges ?? []) drawEdge(edge, 'removed');
  for (const id of Object.keys(board.edges).sort(compareStrings)) {
    drawEdge(board.edges[id] as BoardEdge, marks?.edges.get(id));
  }
  out.push('</g>');

  // ── Cards ──
  out.push('<g>');
  for (const node of marks?.removedNodes ?? []) {
    const rect = marks?.removedRects.get(node.id);
    if (node.type !== 'frame' && rect) out.push(cardSvg(node, rect, theme, 'removed', marks));
  }
  const cards = Object.values(board.nodes)
    .filter((node) => node.type !== 'frame')
    .sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || compareStrings(a.id, b.id));
  for (const node of cards) {
    out.push(cardSvg(node, rects.get(node.id) as Rect, theme, marks?.nodes.get(node.id), marks));
  }
  out.push('</g>');

  if (labels.length > 0) out.push('<g>', ...labels, '</g>');
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

function defs(prefix: string, theme: SvgTheme): string {
  const marker = (name: string, color: string) =>
    `<marker id="${prefix}-${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M1.5 1.5L9 5L1.5 8.5" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>`;
  return [
    '<defs>',
    `<pattern id="${prefix}-grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0.5H0.5V32" fill="none" stroke="${theme.grid}" stroke-width="1"/></pattern>`,
    marker('m-muted', theme.edge.muted),
    marker('m-ink', theme.edge.ink),
    marker('m-danger', theme.edge.danger),
    marker('m-added', theme.diff.added),
    marker('m-removed', theme.diff.removed),
    marker('m-updated', theme.diff.updated),
    '</defs>',
  ].join('\n');
}

/** Line style by edge type, as in the Mermaid export: dashed relates_to, thick blocks. */
function edgeStyle(type: string, theme: SvgTheme, mark: Mark): EdgeStyle {
  let style: EdgeStyle;
  if (type === 'relates_to')
    style = { color: theme.edge.muted, width: 1.5, dash: '5 4', marker: 'm-muted' };
  else if (type === 'blocks') style = { color: theme.edge.danger, width: 2.25, marker: 'm-danger' };
  else if (BUILTIN_SOLID.has(type)) style = { color: theme.edge.ink, width: 1.5, marker: 'm-ink' };
  else style = { color: theme.edge.muted, width: 1.5, marker: 'm-muted' };
  if (mark === 'added')
    return {
      ...style,
      color: theme.diff.added,
      marker: 'm-added',
      width: Math.max(style.width, 2),
    };
  if (mark === 'removed') {
    return {
      ...style,
      color: theme.diff.removed,
      marker: 'm-removed',
      dash: '6 4',
      width: Math.max(style.width, 1.75),
    };
  }
  if (mark === 'updated')
    return {
      ...style,
      color: theme.diff.updated,
      marker: 'm-updated',
      width: Math.max(style.width, 2),
    };
  return style;
}

const BUILTIN_SOLID = new Set(['depends_on', 'implements', 'evidence_for', 'flows_to']);

/** The outline: the diff mark's when there is one, else `line` (none when `line` is not given). */
function markStroke(theme: SvgTheme, mark: Mark, line?: string): string {
  if (mark === 'added') return `stroke="${theme.diff.added}" stroke-width="2"`;
  if (mark === 'updated') return `stroke="${theme.diff.updated}" stroke-width="2"`;
  if (mark === 'removed')
    return `stroke="${theme.diff.removed}" stroke-width="1.75" stroke-dasharray="6 4"`;
  return line ? `stroke="${line}" stroke-width="1"` : 'stroke="none"';
}

/** A small round badge on the top-right corner: `+` added, `−` removed. */
function badge(rect: Rect, theme: SvgTheme, mark: Mark): string {
  if (mark !== 'added' && mark !== 'removed') return '';
  const cx = rect.x + rect.w - 2;
  const cy = rect.y + 2;
  const color = mark === 'added' ? theme.diff.added : theme.diff.removed;
  const vertical = mark === 'added' ? `M${n(cx)} ${n(cy - 4)}V${n(cy + 4)}` : '';
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="8" fill="${color}"/><path d="M${n(cx - 4)} ${n(cy)}H${n(cx + 4)}${vertical}" stroke="${theme.diff.onBadge}" stroke-width="1.8" stroke-linecap="round"/>`;
}

/** The small amber note naming changed fields (and "moved"), right-aligned at `right`. */
function changeNote(node: BoardNode, marks: DiffMarks | undefined, mark: Mark): string[] {
  if (!marks) return [];
  const parts: string[] = [];
  if (mark === 'updated') {
    const fields = marks.fields.get(node.id) ?? [];
    parts.push(fields.length ? fields.join(', ') : 'changed');
  }
  if (marks.moved.has(node.id)) parts.push('moved');
  return parts;
}

function frameSvg(
  node: BoardNode,
  rect: Rect,
  theme: SvgTheme,
  mark: Mark,
  marks: DiffMarks | undefined,
): string {
  const parts: string[] = [`<g data-id="${xmlEscape(node.id)}">`];
  const fillOpacity = mark === 'removed' ? 0 : theme.frameFillOpacity;
  parts.push(
    `<rect x="${n(rect.x)}" y="${n(rect.y)}" width="${n(rect.w)}" height="${n(rect.h)}" rx="20" fill="${theme.frameFill}" fill-opacity="${fillOpacity}" ${markStroke(theme, mark)}/>`,
  );
  const note = changeNote(node, marks, mark);
  const noteText = note.join(' · ');
  const noteWidth = noteText ? Math.min(measureText(noteText, FONT_NOTE), rect.w / 2) : 0;
  const titleWidth = rect.w - 32 - (noteWidth ? noteWidth + 12 : 0);
  const title = truncateToWidth(node.title, Math.max(titleWidth, 24), FONT_FRAME);
  parts.push(
    text(
      rect.x + 16,
      rect.y + 25,
      title,
      `fill="${mark === 'removed' ? theme.ink3 : theme.ink}"`,
      FONT_FRAME,
    ),
  );
  if (mark === 'removed')
    parts.push(strike(rect.x + 16, rect.y + 20.5, measureText(title, FONT_FRAME), theme));
  if (noteText) {
    const color = mark === 'updated' ? theme.diff.updated : theme.diff.moved;
    parts.push(
      text(
        rect.x + rect.w - 16,
        rect.y + 24,
        truncateToWidth(noteText, noteWidth, FONT_NOTE),
        `text-anchor="end" fill="${color}"`,
        FONT_NOTE,
        SVG_FONT_MONO,
      ),
    );
  }
  parts.push(badge(rect, theme, mark), '</g>');
  return parts.join('');
}

/** A line through text; the measure runs a little wide, so the line is a little shorter. */
function strike(x: number, y: number, width: number, theme: SvgTheme): string {
  return `<path d="M${n(x)} ${n(y)}H${n(x + width * 0.94)}" stroke="${theme.diff.removed}" stroke-width="1.5"/>`;
}

function cardSvg(
  node: BoardNode,
  rect: Rect,
  theme: SvgTheme,
  mark: Mark,
  marks: DiffMarks | undefined,
): string {
  const { x, y, w, h } = rect;
  const known = Object.hasOwn(theme.types, node.type) ? node.type : 'custom';
  const tone = theme.types[known] ?? theme.ink2;
  const fill = theme.fills[known] ?? theme.card;
  const inner = w - CARD_PAD_X * 2;
  const removed = mark === 'removed';
  const parts: string[] = [
    `<g data-id="${xmlEscape(node.id)}"${removed ? ' opacity="0.7"' : ''}>`,
    `<title>${xmlEscape(node.title)}</title>`,
    `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="10" fill="${removed ? 'none' : fill}" ${markStroke(theme, mark, theme.fillLines[known])}/>`,
  ];

  // Type row: glyph, name and, in a diff, what changed.
  const note = changeNote(node, marks, mark).join(' · ');
  const label = typeLabel(node.type);
  const labelRoom = Math.max(24, inner - 20);
  const labelText = truncateToWidth(
    label,
    note ? Math.min(labelRoom, measureText(label, FONT_TYPE)) : labelRoom,
    FONT_TYPE,
  );
  parts.push(
    typeGlyph(node.type, x + CARD_PAD_X - 1, y + 12, tone),
    text(x + CARD_PAD_X + 19, y + 23.5, labelText, `fill="${tone}"`, FONT_TYPE),
  );
  if (note) {
    const room = inner - 20 - measureText(labelText, FONT_TYPE) - 12;
    if (room > 30) {
      const color = mark === 'updated' ? theme.diff.updated : theme.diff.moved;
      parts.push(
        text(
          x + w - CARD_PAD_X,
          y + 23,
          truncateToWidth(note, room, FONT_NOTE),
          `text-anchor="end" fill="${color}"`,
          FONT_NOTE,
          SVG_FONT_MONO,
        ),
      );
    }
  }

  // Vertical budget, as the canvas lays a card out (see `defaultNodeSize`).
  const body = node.body ? plainText(node.body) : '';
  const tags = node.tags ?? [];
  const links = node.links ?? [];
  const hasMeta = node.status !== undefined || tags.length > 0 || links.length > 0;
  const showMeta = hasMeta && h >= 40 + 24 + 32;
  const reserved = 40 + (showMeta ? 32 : 0);
  const maxTitleLines = h - reserved - (body ? 48 : 0) >= 48 ? 2 : 1;
  const titleLines = wrapText(node.title, inner, maxTitleLines, FONT_TITLE);
  titleLines.forEach((line, i) => {
    parts.push(
      text(
        x + CARD_PAD_X,
        y + 46 + i * 20,
        line,
        `fill="${removed ? theme.ink3 : theme.ink}"`,
        FONT_TITLE,
      ),
    );
    if (removed) {
      parts.push(strike(x + CARD_PAD_X, y + 41 + i * 20, measureText(line, FONT_TITLE), theme));
    }
  });
  const titleEnd = y + 27 + Math.max(1, titleLines.length) * 24;
  if (body && y + h - (showMeta ? 32 : 0) - titleEnd >= 30) {
    parts.push(
      text(
        x + CARD_PAD_X,
        titleEnd + 20,
        truncateToWidth(body, inner, FONT_BODY),
        `fill="${theme.ink}" fill-opacity="0.7"`,
        FONT_BODY,
      ),
    );
  }

  if (showMeta) {
    const top = y + h - 31;
    let cursor = x + CARD_PAD_X;
    const limit = x + w - CARD_PAD_X;
    const linkText = links.length ? `${links.length} link${links.length === 1 ? '' : 's'}` : '';
    const linkWidth = linkText ? measureText(linkText, FONT_NOTE) + 8 : 0;
    if (node.status) {
      const color = theme.status[node.status];
      // Capitalise only the picture's label. Text formats keep STATUS_WORDS unchanged.
      const statusWords = STATUS_WORDS[node.status];
      const words = statusWords.charAt(0).toUpperCase() + statusWords.slice(1);
      const pillW = Math.min(measureText(words, FONT_PILL) + 24, limit - cursor);
      parts.push(
        `<rect x="${n(cursor)}" y="${n(top)}" width="${n(pillW)}" height="20" rx="10" fill="${theme.chip.color}" fill-opacity="${theme.chip.opacity}"/>`,
        statusGlyph(node.status, cursor + 10, top + 10, color),
        text(
          cursor + 18,
          top + 14,
          truncateToWidth(words, pillW - 23.5, FONT_PILL),
          `fill="${color}"`,
          FONT_PILL,
        ),
      );
      cursor += pillW + 5;
    }
    const shown = tags.slice(0, MAX_TAGS);
    const extra = tags.length - shown.length;
    for (const [i, tag] of shown.entries()) {
      const more = i === shown.length - 1 && extra > 0 ? 34 : 0;
      const room = limit - linkWidth - cursor - more;
      if (room < 36) break;
      const tagText = truncateToWidth(tag, Math.min(room, 120) - 14, FONT_TAG);
      const tagW = measureText(tagText, FONT_TAG) + 14;
      parts.push(
        `<rect x="${n(cursor)}" y="${n(top)}" width="${n(tagW)}" height="20" rx="10" fill="${theme.chipQuiet.color}" fill-opacity="${theme.chipQuiet.opacity}"/>`,
        text(cursor + 7, top + 14, tagText, `fill="${theme.ink}" fill-opacity="0.7"`, FONT_TAG),
      );
      cursor += tagW + 5;
    }
    if (extra > 0 && limit - linkWidth - cursor >= 30) {
      const moreText = `+${extra}`;
      const moreW = measureText(moreText, FONT_TAG) + 14;
      parts.push(
        `<rect x="${n(cursor)}" y="${n(top)}" width="${n(moreW)}" height="20" rx="10" fill="${theme.chipQuiet.color}" fill-opacity="${theme.chipQuiet.opacity}"/>`,
        text(cursor + 7, top + 14, moreText, `fill="${theme.ink}" fill-opacity="0.7"`, FONT_TAG),
      );
      cursor += moreW + 5;
    }
    if (linkText && limit - cursor >= linkWidth) {
      parts.push(
        text(
          limit,
          top + 14,
          linkText,
          `text-anchor="end" fill="${theme.ink}" fill-opacity="0.7"`,
          FONT_NOTE,
          SVG_FONT_MONO,
        ),
      );
    }
  }

  parts.push(badge(rect, theme, mark), '</g>');
  return parts.join('');
}

/** Status as a shape as well as a colour: hollow, half, barred, filled or crossed circle. */
function statusGlyph(status: string, cx: number, cy: number, color: string): string {
  const ring = `<circle cx="${n(cx)}" cy="${n(cy)}" r="4" fill="none" stroke="${color}" stroke-width="1.5"/>`;
  switch (status) {
    case 'in_progress':
      return `${ring}<path d="M${n(cx)} ${n(cy - 4)}A4 4 0 0 1 ${n(cx)} ${n(cy + 4)}Z" fill="${color}"/>`;
    case 'blocked':
      return `${ring}<path d="M${n(cx - 2.6)} ${n(cy + 2.6)}L${n(cx + 2.6)} ${n(cy - 2.6)}" stroke="${color}" stroke-width="1.5"/>`;
    case 'done':
      return `<circle cx="${n(cx)}" cy="${n(cy)}" r="4.75" fill="${color}"/>`;
    case 'cancelled':
      return `${ring}<path d="M${n(cx - 2)} ${n(cy)}H${n(cx + 2)}" stroke="${color}" stroke-width="1.5"/>`;
    default:
      return ring;
  }
}

interface LegendItem {
  label: string;
  color: string;
  width: number;
}

function legendItems(diff: BoardDiff, theme: SvgTheme): LegendItem[] {
  const counts: Array<[number, string, string]> = [
    [diff.nodes.added.length + diff.edges.added.length, 'added', theme.diff.added],
    [diff.nodes.removed.length + diff.edges.removed.length, 'removed', theme.diff.removed],
    [diff.nodes.updated.length + diff.edges.updated.length, 'changed', theme.diff.updated],
    [diff.nodes.moved.length, 'moved', theme.diff.moved],
  ];
  return counts
    .filter(([count]) => count > 0)
    .map(([count, word, color]) => {
      const label = `${count} ${word}`;
      return { label, color, width: 15 + measureText(label, FONT_LEGEND) + 18 };
    });
}

function emptySvg(
  board: Board,
  theme: SvgTheme,
  showTitle: boolean,
  prefix: string,
  maxWidth: number | undefined,
): string {
  const w = 360;
  const h = showTitle ? 200 : 160;
  const scale = maxWidth && maxWidth > 0 && w > maxWidth ? maxWidth / w : 1;
  const top = showTitle ? 40 : 0;
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${n(w * scale)}" height="${n(h * scale)}" role="img" aria-labelledby="${prefix}-title" font-family="${SVG_FONT_SANS}">`,
    `<title id="${prefix}-title">${xmlEscape(board.name)}</title>`,
    `<rect width="${w}" height="${h}" fill="${theme.canvas}"/>`,
  ];
  if (showTitle) {
    lines.push(
      text(
        24,
        34,
        truncateToWidth(board.name, w - 48, FONT_BOARD),
        `fill="${theme.ink}"`,
        FONT_BOARD,
      ),
    );
  }
  lines.push(
    `<rect x="24" y="${top + 24}" width="${w - 48}" height="${h - top - 48}" rx="12" fill="none" stroke="${theme.lineStrong}" stroke-dasharray="6 5"/>`,
    text(
      w / 2,
      top + (h - top) / 2 + 5,
      'Empty board',
      `text-anchor="middle" fill="${theme.ink3}"`,
      { size: 14 },
    ),
    '</svg>',
  );
  return `${lines.join('\n')}\n`;
}
