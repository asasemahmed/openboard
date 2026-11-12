/**
 * Plain geometry over board JSON: node sizes, absolute rectangles, overlap
 * detection, and applying a layout patch. Everything here is pure.
 */
import {
  type Board,
  type BoardNode,
  defaultNodeSize,
  FRAME_MIN,
  FRAME_PADDING,
  GRID,
  type View,
} from '@openboard/core';

/** Node id -> complete new view (keeps `pinned`, `color`, `collapsed` unless a scope says otherwise). */
export type LayoutPatch = Map<string, View>;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/** Round up to the canvas grid. */
export function ceilToGrid(value: number): number {
  return Math.ceil(value / GRID) * GRID;
}

/** Round down to the canvas grid. */
export function floorToGrid(value: number): number {
  return Math.floor(value / GRID) * GRID;
}

/** The size a node renders at: its view's `w`/`h` when set, otherwise `defaultNodeSize`. */
export function nodeSize(node: BoardNode, view: View | undefined = node.view): Size {
  const fallback = defaultNodeSize(node);
  return { w: view?.w ?? fallback.w, h: view?.h ?? fallback.h };
}

/** True when the two rectangles share some area. Touching edges do not count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** True when `a` and `b` are closer than `gap` on both axes (that is, `a` grown by the gap overlaps `b`). */
export function rectsTooClose(a: Rect, b: Rect, gap: { x: number; y: number }): boolean {
  return (
    a.x < b.x + b.w + gap.x &&
    b.x < a.x + a.w + gap.x &&
    a.y < b.y + b.h + gap.y &&
    b.y < a.y + a.h + gap.y
  );
}

/**
 * The smallest frame size that contains `children` (rectangles relative to the
 * frame) plus `FRAME_PADDING`, never below `FRAME_MIN`, rounded up to the grid.
 */
export function frameSizeFor(children: readonly Rect[]): Size {
  let right = 0;
  let bottom = 0;
  for (const r of children) {
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  }
  return {
    w: Math.max(FRAME_MIN.w, ceilToGrid(right + FRAME_PADDING.right)),
    h: Math.max(FRAME_MIN.h, ceilToGrid(bottom + FRAME_PADDING.bottom)),
  };
}

/**
 * The frame a node sits in, or `undefined` for the canvas. A `parent` that does
 * not name an existing frame is treated as no parent.
 */
export function parentFrameOf(board: Board, node: BoardNode): string | undefined {
  const parentId = node.parent;
  if (parentId === undefined) return undefined;
  return board.nodes[parentId]?.type === 'frame' ? parentId : undefined;
}

/**
 * Absolute canvas rectangle of a node: its view offset by every ancestor
 * frame's position. A node without a view counts as sitting at its parent's
 * origin. Returns `undefined` for an unknown id.
 */
export function absoluteRect(board: Board, nodeId: string): Rect | undefined {
  const node = board.nodes[nodeId];
  if (!node) return undefined;
  const size = nodeSize(node);
  let x = node.view?.x ?? 0;
  let y = node.view?.y ?? 0;
  const seen = new Set<string>([nodeId]);
  let parentId = parentFrameOf(board, node);
  while (parentId !== undefined && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = board.nodes[parentId];
    if (!parent) break;
    x += parent.view?.x ?? 0;
    y += parent.view?.y ?? 0;
    parentId = parentFrameOf(board, parent);
  }
  return { x, y, w: size.w, h: size.h };
}

/**
 * Pairs of sibling nodes (same parent frame, or both on the canvas) whose
 * rectangles overlap. Only nodes with a view are considered. A frame and its
 * own children are never siblings, so they never count. Each pair is sorted,
 * and the list is sorted, so the result is stable.
 */
export function findOverlaps(board: Board): Array<[string, string]> {
  const groups = new Map<string, Array<{ id: string; rect: Rect }>>();
  for (const id of Object.keys(board.nodes).sort()) {
    const node = board.nodes[id];
    if (!node?.view) continue;
    const key = parentFrameOf(board, node) ?? '';
    const size = nodeSize(node);
    const entry = { id, rect: { x: node.view.x, y: node.view.y, w: size.w, h: size.h } };
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const pairs: Array<[string, string]> = [];
  for (const group of groups.values()) {
    // Sweep along x so large groups stay fast.
    const byX = [...group].sort((a, b) => a.rect.x - b.rect.x || (a.id < b.id ? -1 : 1));
    for (let i = 0; i < byX.length; i++) {
      const a = byX[i];
      if (!a) continue;
      for (let j = i + 1; j < byX.length; j++) {
        const b = byX[j];
        if (!b) continue;
        if (b.rect.x >= a.rect.x + a.rect.w) break;
        if (rectsOverlap(a.rect, b.rect)) pairs.push(a.id < b.id ? [a.id, b.id] : [b.id, a.id]);
      }
    }
  }
  return pairs.sort((p, q) => (p[0] === q[0] ? cmp(p[1], q[1]) : cmp(p[0], q[0])));
}

/** Returns a new board with the patch's views applied. Ids that are not on the board are ignored. */
export function applyLayoutPatch(board: Board, patch: LayoutPatch): Board {
  if (patch.size === 0) return board;
  const nodes: Board['nodes'] = { ...board.nodes };
  for (const [id, view] of patch) {
    const node = nodes[id];
    if (node) nodes[id] = { ...node, view: { ...view } };
  }
  return { ...board, nodes };
}

/** Field-by-field equality of two views (`undefined` equals `undefined`). */
export function sameView(a: View | undefined, b: View | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    a.pinned === b.pinned &&
    a.color === b.color &&
    a.collapsed === b.collapsed
  );
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
