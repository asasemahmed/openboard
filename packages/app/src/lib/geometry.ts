/**
 * Canvas geometry on top of core's coordinate rule: a node's `x`/`y` are
 * relative to its parent frame's top-left corner (or the canvas origin).
 * Everything here is pure and works on a `PlacementMap`, a flat snapshot of
 * where each node is drawn.
 */
import { FRAME_PADDING } from '@openboard/core';

export interface XY {
  x: number;
  y: number;
}

export interface Rect extends XY {
  w: number;
  h: number;
}

export interface Placement extends Rect {
  id: string;
  /** Parent frame id; `x`/`y` are relative to it. */
  parent?: string;
  frame: boolean;
}

export type PlacementMap = ReadonlyMap<string, Placement>;

/** A node's rectangle in canvas coordinates. Undefined for unknown ids or parent cycles. */
export function absoluteRect(id: string, map: PlacementMap): Rect | undefined {
  const start = map.get(id);
  if (!start) return undefined;
  let x = start.x;
  let y = start.y;
  const seen = new Set<string>([id]);
  let parent = start.parent;
  while (parent !== undefined) {
    if (seen.has(parent)) return undefined;
    seen.add(parent);
    const p = map.get(parent);
    if (!p) break;
    x += p.x;
    y += p.y;
    parent = p.parent;
  }
  return { x, y, w: start.w, h: start.h };
}

/** Canvas position of the origin that `parent`'s children are measured from. */
export function originOf(parent: string | undefined, map: PlacementMap): XY {
  if (parent === undefined) return { x: 0, y: 0 };
  const rect = absoluteRect(parent, map);
  return rect ? { x: rect.x, y: rect.y } : { x: 0, y: 0 };
}

/** Convert a canvas point to coordinates relative to `parent`. */
export function toParentSpace(point: XY, parent: string | undefined, map: PlacementMap): XY {
  const origin = originOf(parent, map);
  return { x: point.x - origin.x, y: point.y - origin.y };
}

/** Convert a point relative to `parent` to canvas coordinates. */
export function toCanvasSpace(point: XY, parent: string | undefined, map: PlacementMap): XY {
  const origin = originOf(parent, map);
  return { x: point.x + origin.x, y: point.y + origin.y };
}

/**
 * Where `id` must sit, relative to `newParent`, to stay exactly where it is
 * drawn now. This is what keeps a node from jumping when it is reparented.
 */
export function reparentPosition(
  id: string,
  newParent: string | undefined,
  map: PlacementMap,
): XY | undefined {
  const rect = absoluteRect(id, map);
  if (!rect) return undefined;
  return toParentSpace(rect, newParent, map);
}

/** True when `ancestor` is `id` itself or one of its frames. */
export function isSelfOrInside(id: string, ancestor: string, map: PlacementMap): boolean {
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = map.get(current)?.parent;
  }
  return false;
}

export function depthOf(id: string, map: PlacementMap): number {
  let depth = 0;
  const seen = new Set<string>([id]);
  let parent = map.get(id)?.parent;
  while (parent !== undefined && !seen.has(parent)) {
    seen.add(parent);
    depth++;
    parent = map.get(parent)?.parent;
  }
  return depth;
}

function contains(rect: Rect, point: XY): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
}

/**
 * The innermost frame under `point`, skipping `exclude` and everything inside
 * an excluded frame (a frame cannot be dropped into itself or its children).
 */
export function frameAt(
  point: XY,
  map: PlacementMap,
  exclude: ReadonlySet<string> = new Set(),
): string | undefined {
  let best: string | undefined;
  let bestDepth = -1;
  for (const item of map.values()) {
    if (!item.frame) continue;
    let skipped = false;
    for (const ex of exclude) {
      if (isSelfOrInside(item.id, ex, map)) {
        skipped = true;
        break;
      }
    }
    if (skipped) continue;
    const rect = absoluteRect(item.id, map);
    if (!rect || !contains(rect, point)) continue;
    const depth = depthOf(item.id, map);
    if (depth > bestDepth) {
      best = item.id;
      bestDepth = depth;
    }
  }
  return best;
}

export function center(rect: Rect): XY {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

export function boundsOf(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The deepest frame that contains every one of `ids` (not counting the ids themselves). */
export function commonFrame(ids: readonly string[], map: PlacementMap): string | undefined {
  const chains = ids.map((id) => {
    const chain: string[] = [];
    const seen = new Set<string>([id]);
    let parent = map.get(id)?.parent;
    while (parent !== undefined && !seen.has(parent)) {
      chain.unshift(parent);
      seen.add(parent);
      parent = map.get(parent)?.parent;
    }
    return chain;
  });
  const first = chains[0];
  if (!first) return undefined;
  let common: string | undefined;
  for (let i = 0; i < first.length; i++) {
    const candidate = first[i];
    if (chains.every((chain) => chain[i] === candidate)) common = candidate;
    else break;
  }
  return common;
}

/** Drop the ids that sit inside another id of the same list; they move with it. */
export function topLevelOf(ids: readonly string[], map: PlacementMap): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    const seen = new Set<string>([id]);
    let parent = map.get(id)?.parent;
    while (parent !== undefined && !seen.has(parent)) {
      if (set.has(parent)) return false;
      seen.add(parent);
      parent = map.get(parent)?.parent;
    }
    return true;
  });
}

/** Keep a child inside its frame's padded content box (top-left side only). */
export function clampIntoFrame(position: XY): XY {
  return {
    x: Math.max(FRAME_PADDING.left, position.x),
    y: Math.max(FRAME_PADDING.top, position.y),
  };
}

/**
 * New sizes for frames that no longer contain their children, after the
 * placements in `map`. Frames only grow; growth propagates to outer frames.
 */
export function framesToGrow(
  frames: Iterable<string>,
  map: PlacementMap,
): Map<string, { w: number; h: number }> {
  const working = new Map(map);
  const out = new Map<string, { w: number; h: number }>();
  const queue = [...new Set(frames)].sort((a, b) => depthOf(b, map) - depthOf(a, map));
  const children = new Map<string, Placement[]>();
  for (const item of map.values()) {
    if (item.parent === undefined) continue;
    const list = children.get(item.parent);
    if (list) list.push(item);
    else children.set(item.parent, [item]);
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const frame = working.get(id);
    if (!frame?.frame) continue;
    let needW = frame.w;
    let needH = frame.h;
    for (const child of children.get(id) ?? []) {
      const c = working.get(child.id) ?? child;
      needW = Math.max(needW, c.x + c.w + FRAME_PADDING.right);
      needH = Math.max(needH, c.y + c.h + FRAME_PADDING.bottom);
    }
    if (needW > frame.w || needH > frame.h) {
      const size = { w: Math.ceil(needW), h: Math.ceil(needH) };
      out.set(id, size);
      working.set(id, { ...frame, ...size });
      if (frame.parent !== undefined) {
        visited.delete(frame.parent);
        queue.push(frame.parent);
      }
    }
  }
  return out;
}
