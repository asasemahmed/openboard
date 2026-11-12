/**
 * Absolute rectangles for every node, for formats that need positions (JSON
 * Canvas, SVG). Views are relative to the parent frame, so they are summed down
 * the frame tree. Sizes come from `view.w/h` or `defaultNodeSize`; a frame
 * without a size is fitted around its children.
 *
 * Nodes without a view have not been placed by the layout engine yet. They get
 * a simple, deterministic grid inside their container, below whatever is
 * already placed there, so an export never stacks them on top of each other.
 */
import { defaultNodeSize, FRAME_MIN, FRAME_PADDING, NODE_GAP } from '../geometry.js';
import type { Board, BoardNode } from '../schema.js';
import { compareStrings } from '../util.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardGeometry {
  /** Absolute rectangle of every node, by id. */
  rects: Map<string, Rect>;
  /** Frame nesting depth, 0 for nodes on the canvas itself. */
  depth: Map<string, number>;
  /** The box around everything, or null for an empty board. */
  bounds: Rect | null;
}

const ROOT = '';

interface Local {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Positions and sizes of every node of `board` in canvas coordinates. */
export function boardGeometry(board: Board): BoardGeometry {
  const nodes = board.nodes;
  const cyclic = nodesInParentCycles(board);
  const children = new Map<string, BoardNode[]>();
  for (const id of Object.keys(nodes).sort(compareStrings)) {
    const node = nodes[id] as BoardNode;
    // A missing parent, or a parent cycle (invalid boards only), puts the node on the canvas.
    const parent =
      node.parent !== undefined && nodes[node.parent] && !cyclic.has(id) ? node.parent : ROOT;
    const list = children.get(parent);
    if (list) list.push(node);
    else children.set(parent, [node]);
  }

  const local = new Map<string, Local>();

  /** Lay out the children of `container` (relative to it) and return their extent. */
  const layoutChildren = (container: string): { right: number; bottom: number } | null => {
    const list = children.get(container) ?? [];
    if (list.length === 0) return null;
    const placed: BoardNode[] = [];
    const unplaced: BoardNode[] = [];
    for (const child of list) {
      sizeOf(child);
      if (child.view) placed.push(child);
      else unplaced.push(child);
    }
    const isRoot = container === ROOT;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    let left = Number.POSITIVE_INFINITY;
    for (const child of placed) {
      const rect = local.get(child.id) as Local;
      rect.x = child.view?.x ?? 0;
      rect.y = child.view?.y ?? 0;
      right = Math.max(right, rect.x + rect.w);
      bottom = Math.max(bottom, rect.y + rect.h);
      left = Math.min(left, rect.x);
    }
    if (unplaced.length > 0) {
      unplaced.sort(
        (a, b) => compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id),
      );
      const originX = isRoot ? (placed.length ? left : 0) : FRAME_PADDING.left;
      const originY = placed.length
        ? bottom + NODE_GAP.y * (isRoot ? 2 : 1)
        : isRoot
          ? 0
          : FRAME_PADDING.top;
      const columns = Math.max(1, Math.min(isRoot ? 6 : 3, Math.ceil(Math.sqrt(unplaced.length))));
      let colWidth = 0;
      for (const child of unplaced) colWidth = Math.max(colWidth, (local.get(child.id) as Local).w);
      let y = originY;
      for (let start = 0; start < unplaced.length; start += columns) {
        const row = unplaced.slice(start, start + columns);
        let rowHeight = 0;
        row.forEach((child, column) => {
          const rect = local.get(child.id) as Local;
          rect.x = originX + column * (colWidth + NODE_GAP.x);
          rect.y = y;
          rowHeight = Math.max(rowHeight, rect.h);
          right = Math.max(right, rect.x + rect.w);
          bottom = Math.max(bottom, rect.y + rect.h);
        });
        y += rowHeight + NODE_GAP.y;
      }
    }
    return { right, bottom };
  };

  /** Size of a node; for a frame this lays out its children first. */
  const sizeOf = (node: BoardNode): Local => {
    const known = local.get(node.id);
    if (known) return known;
    const rect: Local = { x: 0, y: 0, w: 0, h: 0 };
    local.set(node.id, rect);
    const base = defaultNodeSize(node);
    rect.w = node.view?.w ?? base.w;
    rect.h = node.view?.h ?? base.h;
    if (node.type === 'frame' || children.has(node.id)) {
      const extent = layoutChildren(node.id);
      if (extent) {
        const needW = extent.right + FRAME_PADDING.right;
        const needH = extent.bottom + FRAME_PADDING.bottom;
        const fallback = (children.get(node.id) ?? []).some((child) => !child.view);
        // A frame with a size keeps it unless the grid fallback put children outside it.
        if (node.view?.w === undefined || fallback) rect.w = Math.max(rect.w, needW, FRAME_MIN.w);
        if (node.view?.h === undefined || fallback) rect.h = Math.max(rect.h, needH, FRAME_MIN.h);
      }
    }
    return rect;
  };

  layoutChildren(ROOT);

  const rects = new Map<string, Rect>();
  const depth = new Map<string, number>();
  const place = (container: string, ox: number, oy: number, level: number) => {
    for (const child of children.get(container) ?? []) {
      if (rects.has(child.id)) continue;
      const rect = local.get(child.id);
      if (!rect) continue;
      const abs = { x: ox + rect.x, y: oy + rect.y, w: rect.w, h: rect.h };
      rects.set(child.id, abs);
      depth.set(child.id, level);
      place(child.id, abs.x, abs.y, level + 1);
    }
  };
  place(ROOT, 0, 0, 0);

  let bounds: Rect | null = null;
  for (const rect of rects.values()) bounds = union(bounds, rect);
  return { rects, depth, bounds };
}

/** Ids of nodes whose parent chain leads back to themselves. */
function nodesInParentCycles(board: Board): Set<string> {
  const out = new Set<string>();
  const clear = new Set<string>();
  for (const id of Object.keys(board.nodes)) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined && !clear.has(current) && !out.has(current)) {
      if (onPath.has(current)) {
        for (const member of path.slice(path.indexOf(current))) out.add(member);
        break;
      }
      onPath.add(current);
      path.push(current);
      current = board.nodes[current]?.parent;
    }
    for (const member of path) if (!out.has(member)) clear.add(member);
  }
  return out;
}

/** The smallest rectangle containing both. */
export function union(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export type Side = 'top' | 'right' | 'bottom' | 'left';

/**
 * The sides two rectangles face each other on: left/right when the horizontal
 * gap between them is larger, top/bottom otherwise.
 */
export function facingSides(from: Rect, to: Rect): { from: Side; to: Side } {
  const gapRight = to.x - (from.x + from.w);
  const gapLeft = from.x - (to.x + to.w);
  const gapDown = to.y - (from.y + from.h);
  const gapUp = from.y - (to.y + to.h);
  const horizontal = Math.max(gapRight, gapLeft);
  const vertical = Math.max(gapDown, gapUp);
  if (horizontal > 0 && horizontal >= vertical) {
    return gapRight >= gapLeft ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
  }
  if (vertical > 0) {
    return gapDown >= gapUp ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
  }
  // Overlapping (a frame and something inside it): go by the centres.
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
  }
  return dy >= 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
}

/** The midpoint of one side of a rectangle. */
export function sidePoint(rect: Rect, side: Side): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: rect.x + rect.w / 2, y: rect.y };
    case 'bottom':
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
    case 'left':
      return { x: rect.x, y: rect.y + rect.h / 2 };
    case 'right':
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
  }
}
