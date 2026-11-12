/**
 * Keyboard order between nodes. Tab walks the board in reading order (rows
 * top to bottom, left to right, a frame followed by what it contains);
 * Alt+arrow jumps to the nearest node in that direction.
 */
import { absoluteRect, isSelfOrInside, type PlacementMap, type Rect } from './geometry.js';

/** Every node id in reading order. */
export function readingOrder(map: PlacementMap): string[] {
  const children = new Map<string | undefined, string[]>();
  for (const item of map.values()) {
    // A parent that is not on the board makes the node top-level.
    const parent = item.parent !== undefined && map.has(item.parent) ? item.parent : undefined;
    const list = children.get(parent);
    if (list) list.push(item.id);
    else children.set(parent, [item.id]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | undefined) => {
    for (const id of inRows(children.get(parent) ?? [], map)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (map.get(id)?.frame) visit(id);
    }
  };
  visit(undefined);
  return out;
}

/**
 * Siblings in rows: a node joins the current row when its top is above the
 * middle of the row's first node. Rows go top to bottom, nodes left to right.
 */
function inRows(ids: readonly string[], map: PlacementMap): string[] {
  const items = ids
    .map((id) => map.get(id))
    .filter((p) => p !== undefined)
    .sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));
  const rows: Array<typeof items> = [];
  for (const item of items) {
    const row = rows[rows.length - 1];
    const anchor = row?.[0];
    if (row && anchor && item.y < anchor.y + anchor.h / 2) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x || a.y - b.y).map((p) => p.id));
}

/** The node after (or before) `id` in reading order; the first or last when `id` is unknown. */
export function stepInOrder(
  order: readonly string[],
  id: string | null,
  delta: 1 | -1,
): string | undefined {
  const index = id === null ? -1 : order.indexOf(id);
  if (index < 0) return delta === 1 ? order[0] : order[order.length - 1];
  return order[index + delta];
}

export type Direction = 'up' | 'down' | 'left' | 'right';

const centerOf = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * The nearest node in `direction` from `id`, by centre: distance along the
 * direction plus twice the sideways offset, so nodes in line win over closer
 * ones off to the side. The frames that contain `id` are never candidates.
 */
export function neighborInDirection(
  id: string,
  direction: Direction,
  map: PlacementMap,
): string | undefined {
  const fromRect = absoluteRect(id, map);
  if (!fromRect) return undefined;
  const from = centerOf(fromRect);
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const item of map.values()) {
    if (item.id === id || isSelfOrInside(id, item.id, map)) continue;
    const rect = absoluteRect(item.id, map);
    if (!rect) continue;
    const c = centerOf(rect);
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    const along =
      direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy;
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1) continue;
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = item.id;
    }
  }
  return best;
}
