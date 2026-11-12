/**
 * Recent changes that happened outside the visible part of the canvas,
 * grouped per actor, with the edge of the viewport they lie beyond.
 */
import type { Highlight } from '../state/activity.js';
import { boundsOf, type Rect } from './geometry.js';

export type ViewSide = 'top' | 'right' | 'bottom' | 'left';

export interface Located {
  rect: Rect;
  /** Nodes to bring into view for this entry (an edge's two ends). */
  nodeIds: readonly string[];
}

export interface OffscreenGroup {
  actorId: string;
  count: number;
  side: ViewSide;
  /** Every node to fit the view to, without duplicates. */
  nodeIds: string[];
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Which edge of `view` a point beyond it is closest to, weighing by the view's shape. */
export function sideOf(point: { x: number; y: number }, view: Rect): ViewSide {
  const dx = (point.x - (view.x + view.w / 2)) / Math.max(1, view.w);
  const dy = (point.y - (view.y + view.h / 2)) / Math.max(1, view.h);
  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? 'top' : 'bottom';
  return dx < 0 ? 'left' : 'right';
}

/**
 * One group per actor whose highlighted entries are all or partly out of
 * view; only the out-of-view entries are counted. Groups keep the order in
 * which their actors first appear in `highlights`.
 */
export function offscreenGroups(
  highlights: Iterable<Highlight>,
  locate: (highlight: Highlight) => Located | undefined,
  view: Rect,
): OffscreenGroup[] {
  const byActor = new Map<string, { rects: Rect[]; nodeIds: Set<string> }>();
  for (const h of highlights) {
    const where = locate(h);
    if (!where || intersects(where.rect, view)) continue;
    let group = byActor.get(h.actorId);
    if (!group) {
      group = { rects: [], nodeIds: new Set() };
      byActor.set(h.actorId, group);
    }
    group.rects.push(where.rect);
    for (const id of where.nodeIds) group.nodeIds.add(id);
  }
  const out: OffscreenGroup[] = [];
  for (const [actorId, group] of byActor) {
    const bounds = boundsOf(group.rects);
    if (!bounds) continue;
    out.push({
      actorId,
      count: group.rects.length,
      side: sideOf({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }, view),
      nodeIds: [...group.nodeIds],
    });
  }
  return out;
}
