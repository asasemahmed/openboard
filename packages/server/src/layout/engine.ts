/**
 * The working state shared by full and incremental layout, and the steps both
 * are built from: arranging one container with ELK, placing single nodes into
 * free space, sizing frames, and pushing siblings out of a grown frame's way.
 */
import { type BoardNode, FRAME_PADDING, NODE_GAP, type View } from '@openboard/core';
import { arrangeWithElk, type Direction } from './elk.js';
import {
  ceilToGrid,
  cmp,
  frameSizeFor,
  type LayoutPatch,
  nodeSize,
  type Rect,
  rectsOverlap,
  type Size,
  sameView,
} from './geometry.js';
import { type Axis, findFreeSpot } from './spot.js';
import { ROOT, type Structure } from './structure.js';

/**
 * Main-axis weight for a node placed next to a connected neighbour: one step
 * along the flow costs as much as 2.5 steps across it, so up to five siblings
 * of one neighbour share a row (or column) before a second one starts.
 */
const CONNECTED_WEIGHT = 2.5;
/** Unconnected nodes stack along the flow axis first, in a column (or row) beside their siblings. */
const UNCONNECTED_WEIGHT = 0.9;

export class Workspace {
  /** Current views of every node that has one. */
  readonly views = new Map<string, View>();
  /** Sizes of new frames that are sized but not placed yet. */
  private readonly pendingSize = new Map<string, Size>();

  constructor(
    readonly structure: Structure,
    readonly direction: Direction,
  ) {
    for (const [id, node] of Object.entries(structure.board.nodes)) {
      if (node.view) this.views.set(id, node.view);
    }
  }

  get main(): Axis {
    return this.direction === 'down' ? 'y' : 'x';
  }

  node(id: string): BoardNode | undefined {
    return this.structure.board.nodes[id];
  }

  children(container: string): BoardNode[] {
    return this.structure.children.get(container) ?? [];
  }

  containerOf(id: string): string {
    return this.structure.containerOf.get(id) ?? ROOT;
  }

  size(id: string): Size {
    const node = this.node(id);
    const view = this.views.get(id);
    const pending = this.pendingSize.get(id);
    if (!view && pending) return pending;
    return node ? nodeSize(node, view) : { w: 0, h: 0 };
  }

  rect(id: string): Rect | undefined {
    const view = this.views.get(id);
    if (!view) return undefined;
    const size = this.size(id);
    return { x: view.x, y: view.y, w: size.w, h: size.h };
  }

  /** Rectangles of the container's children that have a view, sorted by id. */
  placedRects(container: string, except?: string): Rect[] {
    const out: Rect[] = [];
    for (const child of this.children(container)) {
      if (child.id === except) continue;
      const r = this.rect(child.id);
      if (r) out.push(r);
    }
    return out;
  }

  setPendingSize(id: string, size: Size): void {
    this.pendingSize.set(id, size);
  }

  /** Every node whose view now differs from the board's, in id order. */
  patch(): LayoutPatch {
    const patch: LayoutPatch = new Map();
    for (const id of [...this.views.keys()].sort(cmp)) {
      const view = this.views.get(id);
      if (view && !sameView(view, this.node(id)?.view)) patch.set(id, view);
    }
    return patch;
  }
}

/** Where a container's content starts: inside the padding of a frame, or the canvas origin. */
export function contentOrigin(container: string): { x: number; y: number } {
  return container === ROOT ? { x: 0, y: 0 } : { x: FRAME_PADDING.left, y: FRAME_PADDING.top };
}

function withoutPinned(view: View): View {
  const copy = { ...view };
  delete copy.pinned;
  return copy;
}

/** The view a node gets when placed at `pos`; frames also record their size. */
function placedView(ws: Workspace, node: BoardNode, pos: { x: number; y: number }): View {
  const view: View = { ...(ws.views.get(node.id) ?? {}), x: pos.x, y: pos.y };
  if (node.type === 'frame') {
    const size = ws.size(node.id);
    view.w = size.w;
    view.h = size.h;
  }
  return view;
}

/**
 * Lays out the children of `container` from scratch with ELK. Children for
 * which `isFixed` is true (and that have a view) keep it exactly; the rest are
 * laid out as one block, which is then moved to the free spot nearest the
 * content origin that keeps `NODE_GAP` from every fixed child's rectangle.
 * Child frames must already be sized.
 */
export async function arrangeContainer(
  ws: Workspace,
  container: string,
  isFixed: (node: BoardNode) => boolean,
  stripPinned: boolean,
): Promise<void> {
  const kids = ws.children(container);
  const fixed: Rect[] = [];
  const movable: BoardNode[] = [];
  for (const kid of kids) {
    const r = ws.rect(kid.id);
    if (r && isFixed(kid)) fixed.push(r);
    else movable.push(kid);
  }
  if (movable.length === 0) return;
  const items = movable.map((n) => ({ id: n.id, ...ws.size(n.id) }));
  const positions = await arrangeWithElk(
    items,
    ws.structure.flow.get(container) ?? [],
    ws.direction,
  );
  let w = 0;
  let h = 0;
  for (const item of items) {
    const p = positions.get(item.id);
    if (!p) continue;
    w = Math.max(w, p.x + item.w);
    h = Math.max(h, p.y + item.h);
  }
  const origin = contentOrigin(container);
  const offset =
    fixed.length === 0
      ? origin
      : findFreeSpot({
          ideal: origin,
          size: { w, h },
          obstacles: fixed,
          min: origin,
          main: ws.main,
          mainWeight: 1,
        });
  for (const node of movable) {
    const p = positions.get(node.id) ?? { x: 0, y: 0 };
    const view = placedView(ws, node, { x: offset.x + p.x, y: offset.y + p.y });
    ws.views.set(node.id, stripPinned ? withoutPinned(view) : view);
  }
}

/**
 * Places the given children of `container` one at a time, each at the free
 * spot nearest to what it is connected to:
 *
 * - after its upstream neighbours (below for `down`, right of them for `right`),
 * - otherwise before its downstream neighbours,
 * - otherwise beside the block of its existing siblings, across the flow.
 *
 * Nodes connected to something already placed go first, so chains grow out
 * from the existing layout.
 */
export function placeEach(ws: Workspace, container: string, fresh: readonly BoardNode[]): void {
  const ups = new Map<string, string[]>();
  const downs = new Map<string, string[]>();
  for (const [up, down] of ws.structure.flow.get(container) ?? []) {
    pushTo(ups, down, up);
    pushTo(downs, up, down);
  }
  const main = ws.main;
  const cross: Axis = main === 'x' ? 'y' : 'x';
  const mainExt = main === 'x' ? 'w' : 'h';
  const crossExt = main === 'x' ? 'h' : 'w';
  const origin = contentOrigin(container);
  const min = container === ROOT ? undefined : origin;

  const remaining = [...fresh].sort((a, b) => cmp(a.id, b.id));
  while (remaining.length > 0) {
    let index = remaining.findIndex((n) =>
      [...(ups.get(n.id) ?? []), ...(downs.get(n.id) ?? [])].some((id) => ws.views.has(id)),
    );
    if (index < 0) index = 0;
    const [node] = remaining.splice(index, 1);
    if (!node) break;

    const size = ws.size(node.id);
    const obstacles = ws.placedRects(container, node.id);
    const upRects = rectsOf(ws, ups.get(node.id));
    const downRects = rectsOf(ws, downs.get(node.id));
    let ideal: { x: number; y: number };
    let side: 1 | -1 | undefined;
    let weight = CONNECTED_WEIGHT;
    const anchors = upRects.length > 0 ? upRects : downRects;
    if (anchors.length > 0) {
      let centre = 0;
      for (const r of anchors) centre += r[cross] + r[crossExt] / 2;
      centre /= anchors.length;
      const crossPos = centre - size[crossExt] / 2;
      let mainPos: number;
      if (upRects.length > 0) {
        mainPos = Math.max(...upRects.map((r) => r[main] + r[mainExt])) + NODE_GAP[main];
        side = 1;
      } else {
        mainPos = Math.min(...downRects.map((r) => r[main])) - size[mainExt] - NODE_GAP[main];
        side = -1;
      }
      ideal = main === 'x' ? { x: mainPos, y: crossPos } : { x: crossPos, y: mainPos };
    } else {
      weight = UNCONNECTED_WEIGHT;
      if (obstacles.length === 0) {
        ideal = origin;
      } else {
        const mainStart = Math.min(...obstacles.map((r) => r[main]));
        const crossEnd = Math.max(...obstacles.map((r) => r[cross] + r[crossExt]));
        const crossPos = crossEnd + NODE_GAP[cross];
        ideal = main === 'x' ? { x: mainStart, y: crossPos } : { x: crossPos, y: mainStart };
      }
    }
    const spot = findFreeSpot({ ideal, size, obstacles, min, main, mainWeight: weight, side });
    ws.views.set(node.id, placedView(ws, node, spot));
  }
}

function pushTo(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function rectsOf(ws: Workspace, ids: readonly string[] | undefined): Rect[] {
  const out: Rect[] = [];
  for (const id of ids ?? []) {
    const r = ws.rect(id);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Sizes a frame to its children. `fit` sets the exact size (it may shrink);
 * `grow` only ever enlarges it. A frame without a view (a new frame) is always
 * fitted and gets its view when it is placed. Position is never touched.
 * Returns the frame's previous rectangle when it grew, so the caller can make
 * room around it.
 */
export function sizeFrame(ws: Workspace, frameId: string, mode: 'fit' | 'grow'): Rect | undefined {
  const fit = frameSizeFor(ws.placedRects(frameId));
  const view = ws.views.get(frameId);
  if (!view) {
    ws.setPendingSize(frameId, fit);
    return undefined;
  }
  const before = ws.rect(frameId);
  if (!before) return undefined;
  const next =
    mode === 'fit' ? fit : { w: Math.max(before.w, fit.w), h: Math.max(before.h, fit.h) };
  if (next.w === before.w && next.h === before.h) return undefined;
  ws.views.set(frameId, { ...view, w: next.w, h: next.h });
  return next.w > before.w || next.h > before.h ? before : undefined;
}

/**
 * Makes room for child frames of `container` that grew. A sibling that a grown
 * frame now overlaps is pushed out along the axis the frame grew into (right
 * when it sat to the right of the old frame, down when it sat below, otherwise
 * whichever is the shorter move), to one gap past the frame. Whatever a pushed
 * node lands on is pushed the same way in turn. Pinned siblings never move: an
 * overlap with one is left as it is.
 */
export function makeRoom(ws: Workspace, container: string, grown: ReadonlyMap<string, Rect>): void {
  const kids = ws.children(container);
  const grownHere = kids.filter((k) => grown.has(k.id));
  if (grownHere.length === 0) return;
  let budget = 50 * kids.length + 50;
  for (const frame of grownHere) {
    const old = grown.get(frame.id);
    const start = ws.rect(frame.id);
    if (!old || !start) continue;
    const queue: Array<{ id: string; rect: Rect; axis?: Axis }> = [{ id: frame.id, rect: start }];
    while (queue.length > 0 && budget > 0) {
      const pusher = queue.shift();
      if (!pusher) break;
      for (const kid of kids) {
        if (kid.id === pusher.id || kid.id === frame.id) continue;
        const view = ws.views.get(kid.id);
        const r = ws.rect(kid.id);
        if (!view || !r || view.pinned === true || !rectsOverlap(pusher.rect, r)) continue;
        const p = pusher.rect;
        const toX = ceilToGrid(p.x + p.w + NODE_GAP.x);
        const toY = ceilToGrid(p.y + p.h + NODE_GAP.y);
        let axis = pusher.axis;
        if (axis === undefined) {
          if (r.x >= old.x + old.w) axis = 'x';
          else if (r.y >= old.y + old.h) axis = 'y';
          else axis = toX - r.x <= toY - r.y ? 'x' : 'y';
        }
        const moved: Rect = axis === 'x' ? { ...r, x: toX } : { ...r, y: toY };
        ws.views.set(kid.id, { ...view, x: moved.x, y: moved.y });
        queue.push({ id: kid.id, rect: moved, axis });
        budget--;
      }
    }
  }
}
