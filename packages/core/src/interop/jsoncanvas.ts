/**
 * JSON Canvas 1.0 (jsoncanvas.org), the open format of Obsidian canvases.
 *
 * Export: frames become `group` nodes; a code or doc node whose first link is a
 * file becomes a `file` node; a node that is nothing but one URL becomes a
 * `link` node; everything else is a `text` node holding markdown (`## title`,
 * a line with type, status and tags, then the body). Positions are absolute,
 * because JSON Canvas has no parent-relative coordinates. Board ids are kept
 * as canvas ids. Edge labels carry the edge type when the edge has no label of
 * its own, so types survive a round trip.
 *
 * Import: groups become frames, and the innermost group containing a node's
 * centre becomes its parent. Text nodes take their title from the first
 * heading (or first line); file nodes become `code` nodes and link nodes `doc`
 * nodes. Positions are kept, converted back to parent-relative and pinned.
 */
import type { Op } from '../ops.js';
import { orderNodes } from '../query.js';
import {
  type Board,
  type BoardEdge,
  type BoardNode,
  BUILTIN_EDGE_TYPES,
  BUILTIN_NODE_TYPES,
  LIMITS,
  type Status,
} from '../schema.js';
import { compareStrings } from '../util.js';
import { boardGeometry, facingSides, type Rect } from './layout.js';
import {
  clip,
  fitBody,
  fitTitle,
  oneLine,
  STATUS_WORDS,
  statusFromWords,
  typeWords,
} from './text.js';
import type { ImportResult } from './types.js';

type Side = 'top' | 'right' | 'bottom' | 'left';

export interface CanvasNode {
  id: string;
  type: 'text' | 'file' | 'link' | 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: Side;
  toSide?: Side;
  fromEnd?: 'none' | 'arrow';
  toEnd?: 'none' | 'arrow';
  color?: string;
  label?: string;
}

export interface JsonCanvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** Canvas colour presets: 1 red, 2 orange, 3 yellow, 4 green, 5 cyan, 6 purple. */
const COLOR_BY_TYPE: Record<string, string> = {
  risk: '1',
  agent: '2',
  doc: '3',
  task: '4',
  code: '5',
  question: '5',
  decision: '6',
  run: '6',
};

const COLOR_PATTERN = /^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}|[1-6])$/;

const NODE_TYPES = new Set<string>(BUILTIN_NODE_TYPES);
const CUSTOM_TYPE = /^x:[a-z][a-z0-9_-]{0,39}$/;
const EDGE_TYPE_BY_WORDS = new Map<string, string>(
  BUILTIN_EDGE_TYPES.flatMap((type) => [
    [typeWords(type), type],
    [type, type],
  ]),
);

/** A tag as written on the meta line: `#name`, or `#"with spaces"` when it needs quoting. */
function tagToken(tag: string): string {
  return /^[\p{L}\p{N}_/-]+$/u.test(tag) ? `#${tag}` : `#${JSON.stringify(tag)}`;
}

function metaLine(node: BoardNode): string {
  const parts = [node.type];
  if (node.status) parts.push(STATUS_WORDS[node.status]);
  if (node.tags?.length) parts.push(node.tags.map(tagToken).join(' '));
  return parts.join(' · ');
}

/** A title as heading text; a trailing run of `#` gets a closing sequence so it is kept. */
function headingText(title: string): string {
  const line = oneLine(title);
  return /(^|\s)#+$/.test(line) ? `${line} #` : line;
}

function isUrlOnly(node: BoardNode): boolean {
  return (
    node.links?.length === 1 &&
    node.links[0]?.kind === 'url' &&
    !node.body?.trim() &&
    !node.status &&
    !node.tags?.length &&
    node.props === undefined
  );
}

const round = (value: number) => Math.round(value);

/** The board as a JSON Canvas document (an object; see {@link toJsonCanvas} for text). */
export function toJsonCanvasObject(board: Board): JsonCanvas {
  const { rects } = boardGeometry(board);
  const ordered = orderNodes(board, Object.values(board.nodes));
  // Groups first, outer before inner, so they sit below the cards they contain.
  const sorted = [
    ...ordered.filter((node) => node.type === 'frame'),
    ...ordered.filter((node) => node.type !== 'frame'),
  ];
  const nodes: CanvasNode[] = [];
  for (const node of sorted) {
    const rect = rects.get(node.id) as Rect;
    const base = {
      id: node.id,
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.w),
      height: round(rect.h),
    };
    const color =
      node.view?.color && COLOR_PATTERN.test(node.view.color)
        ? node.view.color
        : COLOR_BY_TYPE[node.type];
    const colored = color ? { color } : {};
    const firstLink = node.links?.[0];
    if (node.type === 'frame') {
      nodes.push({ ...base, type: 'group', label: oneLine(node.title), ...colored });
    } else if ((node.type === 'code' || node.type === 'doc') && firstLink?.kind === 'file') {
      nodes.push({ ...base, type: 'file', file: firstLink.target, ...colored });
    } else if (isUrlOnly(node) && firstLink) {
      nodes.push({ ...base, type: 'link', url: firstLink.target, ...colored });
    } else {
      const lines = [`## ${headingText(node.title)}`, metaLine(node)];
      if (node.body?.trim()) lines.push('', node.body.trimEnd());
      nodes.push({ ...base, type: 'text', text: lines.join('\n'), ...colored });
    }
  }

  const edges: CanvasEdge[] = [];
  for (const id of Object.keys(board.edges).sort(compareStrings)) {
    const edge = board.edges[id] as BoardEdge;
    const from = rects.get(edge.source);
    const to = rects.get(edge.target);
    if (!from || !to) continue;
    const sides = facingSides(from, to);
    const label = edge.label?.trim()
      ? edge.label
      : edge.type === 'relates_to'
        ? undefined
        : typeWords(edge.type);
    edges.push({
      id: edge.id,
      fromNode: edge.source,
      fromSide: sides.from,
      toNode: edge.target,
      toSide: sides.to,
      ...(edge.type === 'blocks' ? { color: '1' } : {}),
      ...(label !== undefined ? { label } : {}),
    });
  }
  return { nodes, edges };
}

/** The board as JSON Canvas file text. */
export function toJsonCanvas(board: Board): string {
  return `${JSON.stringify(toJsonCanvasObject(board), null, 2)}\n`;
}

// ── Import ───────────────────────────────────────────────────────────────────

interface Box {
  index: number;
  raw: Record<string, unknown>;
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function contains(outer: Box, x: number, y: number): boolean {
  return x >= outer.x && x <= outer.x + outer.w && y >= outer.y && y <= outer.y + outer.h;
}

/**
 * Read a canvas text node: the first heading (or the first line) is the
 * title, and the line right after it, when it looks like the one this module
 * writes (`task · in progress · #tag`), gives type, status and tags back.
 */
function readText(text: string): {
  title: string;
  body?: string;
  type?: string;
  status?: Status;
  tags?: string[];
} {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let index = lines.findIndex((line) => line.trim() !== '');
  if (index === -1) return { title: '' };
  const first = lines[index] as string;
  const heading = /^\s{0,3}#{1,6}(?:\s+(.*?))?(?:\s+#+)?\s*$/.exec(first);
  const title = heading ? (heading[1] ?? '') : first.trim();
  index++;
  const out: ReturnType<typeof readText> = { title };
  const meta = lines[index] !== undefined ? readMeta(lines[index] as string) : null;
  if (meta) {
    Object.assign(out, meta);
    index++;
  }
  const body = fitBody(lines.slice(index).join('\n'));
  if (body !== undefined) out.body = body;
  return out;
}

function readMeta(line: string): { type: string; status?: Status; tags?: string[] } | null {
  const parts = line.trim().split(' · ');
  const type = parts.shift();
  if (!type || (!NODE_TYPES.has(type) && !CUSTOM_TYPE.test(type)) || type === 'frame') return null;
  const out: { type: string; status?: Status; tags?: string[] } = { type };
  for (const part of parts) {
    const status = statusFromWords(part);
    if (status && !out.status) {
      out.status = status;
      continue;
    }
    if (!part.startsWith('#')) return null;
    const tags: string[] = [];
    const re = /#"((?:[^"\\]|\\.)*)"|#([^\s#]+)/g;
    for (let found = re.exec(part); found; found = re.exec(part)) {
      if (found[1] !== undefined) {
        try {
          tags.push(JSON.parse(`"${found[1]}"`) as string);
        } catch {
          tags.push(found[1]);
        }
      } else if (found[2] !== undefined) tags.push(found[2]);
    }
    if (tags.length === 0) return null;
    out.tags = tags;
  }
  return out;
}

function cleanTags(tags: string[] | undefined): string[] | undefined {
  if (!tags) return undefined;
  const out = [...new Set(tags.map((tag) => clip(oneLine(tag), LIMITS.tag)).filter(Boolean))];
  return out.slice(0, LIMITS.tagsPerNode);
}

/** Read JSON Canvas text into operations that recreate it. */
export function fromJsonCanvas(text: string): ImportResult {
  const warnings: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ops: [], warnings: [`the canvas is not valid JSON: ${reason}`] };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ops: [], warnings: ['the canvas is not a JSON object with "nodes" and "edges".'] };
  }
  const root = data as Record<string, unknown>;
  const rawNodes = Array.isArray(root.nodes) ? root.nodes : [];
  const rawEdges = Array.isArray(root.edges) ? root.edges : [];
  if (!Array.isArray(root.nodes)) warnings.push('the canvas has no "nodes" list.');

  const boxes: Box[] = [];
  const byId = new Map<string, Box>();
  rawNodes.forEach((value, index) => {
    if (typeof value !== 'object' || value === null) {
      warnings.push(`node ${index} is not an object; skipped.`);
      return;
    }
    const raw = value as Record<string, unknown>;
    const id = str(raw.id) ?? `#${index}`;
    const kind = str(raw.type) ?? 'text';
    if (byId.has(id)) {
      warnings.push(`node id "${clip(id, 40)}" is used twice; the second one was skipped.`);
      return;
    }
    const x = num(raw.x) ?? 0;
    const y = num(raw.y) ?? 0;
    const w = Math.max(1, num(raw.width) ?? 250);
    const h = Math.max(1, num(raw.height) ?? 60);
    if (num(raw.x) === undefined || num(raw.y) === undefined) {
      warnings.push(`node "${clip(id, 40)}" has no position; it was placed at 0,0.`);
    }
    const box: Box = { index, raw, id, kind, x, y, w, h };
    boxes.push(box);
    byId.set(id, box);
  });

  // Parent: the smallest group that contains the centre. A group can only sit
  // in a larger one (or an equal one earlier in the list), so there are no cycles.
  const groups = boxes.filter((box) => box.kind === 'group');
  const area = (box: Box) => box.w * box.h;
  const encloses = (outer: Box, inner: Box) =>
    outer !== inner &&
    (area(outer) > area(inner) || (area(outer) === area(inner) && outer.index < inner.index));
  const parentOf = new Map<string, Box>();
  for (const box of boxes) {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    let best: Box | undefined;
    for (const group of groups) {
      if (!contains(group, cx, cy)) continue;
      if (box.kind === 'group' && !encloses(group, box)) continue;
      if (
        !best ||
        area(group) < area(best) ||
        (area(group) === area(best) && group.index > best.index)
      ) {
        best = group;
      }
    }
    if (best) parentOf.set(box.id, best);
  }

  // Frames outer to inner, then cards in file order.
  const orderedGroups = [...groups].sort((a, b) => area(b) - area(a) || a.index - b.index);
  const refs = new Map<string, string>();
  orderedGroups.forEach((box, i) => refs.set(box.id, `g${i + 1}`));
  let cards = 0;
  for (const box of boxes) if (box.kind !== 'group') refs.set(box.id, `c${++cards}`);

  const ops: Op[] = [];
  for (const box of [...orderedGroups, ...boxes.filter((b) => b.kind !== 'group')]) {
    const parent = parentOf.get(box.id);
    const view = {
      x: box.x - (parent?.x ?? 0),
      y: box.y - (parent?.y ?? 0),
      w: box.w,
      h: box.h,
      pinned: true,
    };
    const common = {
      ...(parent ? { parent: `$${refs.get(parent.id)}` } : {}),
      view,
    };
    const ref = refs.get(box.id) as string;
    switch (box.kind) {
      case 'group': {
        const label = str(box.raw.label);
        ops.push({
          op: 'add_node',
          ref,
          node: { type: 'frame', title: fitTitle(label ?? '', 'Group'), ...common },
        });
        break;
      }
      case 'file': {
        const file = str(box.raw.file);
        if (!file?.trim()) {
          warnings.push(`file node "${clip(box.id, 40)}" names no file; imported as a note.`);
          ops.push({ op: 'add_node', ref, node: { type: 'note', title: 'File', ...common } });
          break;
        }
        const subpath = str(box.raw.subpath);
        ops.push({
          op: 'add_node',
          ref,
          node: {
            type: 'code',
            title: fitTitle(file),
            links: [{ kind: 'file', target: clip(file, 500) }],
            ...(subpath ? { body: `Section: ${subpath}` } : {}),
            ...common,
          },
        });
        break;
      }
      case 'link': {
        const url = str(box.raw.url);
        if (!url?.trim()) {
          warnings.push(`link node "${clip(box.id, 40)}" has no url; imported as a note.`);
          ops.push({ op: 'add_node', ref, node: { type: 'note', title: 'Link', ...common } });
          break;
        }
        ops.push({
          op: 'add_node',
          ref,
          node: {
            type: 'doc',
            title: fitTitle(url),
            links: [{ kind: 'url', target: clip(url, 500) }],
            ...common,
          },
        });
        break;
      }
      default: {
        if (box.kind !== 'text') {
          warnings.push(
            `node "${clip(box.id, 40)}" has unknown type "${clip(box.kind, 20)}"; imported as a note.`,
          );
        }
        const parsed = readText(str(box.raw.text) ?? '');
        if (!parsed.title.trim()) warnings.push(`text node "${clip(box.id, 40)}" is empty.`);
        const tags = cleanTags(parsed.tags);
        ops.push({
          op: 'add_node',
          ref,
          node: {
            type: parsed.type ?? 'note',
            title: fitTitle(parsed.title),
            ...(parsed.body !== undefined ? { body: parsed.body } : {}),
            ...(parsed.status ? { status: parsed.status } : {}),
            ...(tags?.length ? { tags } : {}),
            ...common,
          },
        });
      }
    }
  }

  const seen = new Set<string>();
  rawEdges.forEach((value, index) => {
    if (typeof value !== 'object' || value === null) {
      warnings.push(`edge ${index} is not an object; skipped.`);
      return;
    }
    const raw = value as Record<string, unknown>;
    const name = str(raw.id) ?? `#${index}`;
    const from = str(raw.fromNode);
    const to = str(raw.toNode);
    const source = from !== undefined ? refs.get(from) : undefined;
    const target = to !== undefined ? refs.get(to) : undefined;
    if (!source || !target) {
      warnings.push(`edge "${clip(name, 40)}" points at a node that does not exist; skipped.`);
      return;
    }
    if (source === target) {
      warnings.push(`edge "${clip(name, 40)}" connects a node to itself; skipped.`);
      return;
    }
    const label = oneLine(str(raw.label) ?? '');
    const named = label ? EDGE_TYPE_BY_WORDS.get(label.toLowerCase()) : undefined;
    const type = named ?? 'relates_to';
    const key = `${type}\u0000${source}\u0000${target}`;
    if (seen.has(key)) {
      warnings.push(
        `edge "${clip(name, 40)}" repeats an earlier edge between the same nodes; skipped.`,
      );
      return;
    }
    seen.add(key);
    ops.push({
      op: 'add_edge',
      edge: {
        type,
        source: `$${source}`,
        target: `$${target}`,
        ...(label && !named ? { label: clip(label, LIMITS.label) } : {}),
      },
    });
  });

  if (ops.length > LIMITS.opsPerBatch) {
    warnings.push(
      `the canvas needs ${ops.length} operations but one batch holds ${LIMITS.opsPerBatch}; only the first ${LIMITS.opsPerBatch} were kept.`,
    );
    return { ops: ops.slice(0, LIMITS.opsPerBatch), warnings };
  }
  return { ops, warnings };
}
