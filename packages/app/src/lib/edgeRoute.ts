/**
 * Keeping edges out from under cards. Most edges are a curve between the
 * facing sides of two cards. When that line would cross another card (a
 * stacked column where an edge skips a row, say), the edge instead leaves
 * and enters on the same outer side and runs past the cards in between, as
 * a rounded step path. This is not a router: it handles the common layouts
 * and leaves anything stranger to the curve.
 */
import { edgeEnds, type Side } from './edgeGeometry.js';
import type { Rect, XY } from './geometry.js';

/** Clearance between a detour and the cards it passes. */
export const DETOUR_GAP = 24;
/** Cards are treated as this much larger when testing whether a line crosses them. */
const HIT_MARGIN = 6;

export type Route = { kind: 'curve' } | { kind: 'detour'; side: Side; at: number };

const CURVE: Route = Object.freeze({ kind: 'curve' });

/** Does the segment a-b pass through `rect`? (Liang-Barsky clipping.) */
export function segmentHitsRect(a: XY, b: XY, rect: Rect): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.w - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.h - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t0 < t1;
}

const inflate = (r: Rect, m: number): Rect => ({
  x: r.x - m,
  y: r.y - m,
  w: r.w + 2 * m,
  h: r.h + 2 * m,
});

/**
 * Push a vertical (or horizontal) line at `start` outwards until no obstacle
 * spanning `[lo, hi]` on the other axis sits on it.
 */
function clearLine(
  start: number,
  outward: 1 | -1,
  vertical: boolean,
  lo: number,
  hi: number,
  obstacles: readonly Rect[],
): number {
  let at = start;
  for (let guard = 0; guard <= obstacles.length; guard++) {
    const hit = obstacles.find((o) => {
      const [from, size, crossFrom, crossSize] = vertical
        ? [o.x, o.w, o.y, o.h]
        : [o.y, o.h, o.x, o.w];
      return (
        crossFrom < hi &&
        crossFrom + crossSize > lo &&
        from - DETOUR_GAP / 2 < at &&
        from + size + DETOUR_GAP / 2 > at
      );
    });
    if (!hit) return at;
    const [from, size] = vertical ? [hit.x, hit.w] : [hit.y, hit.h];
    at = outward === 1 ? from + size + DETOUR_GAP : from - DETOUR_GAP;
  }
  return at;
}

/** The route for an edge from `source` to `target`, given the other cards on the canvas. */
export function chooseRoute(source: Rect, target: Rect, obstacles: readonly Rect[]): Route {
  if (obstacles.length === 0) return CURVE;
  const ends = edgeEnds(source, target);
  const a = { x: ends.sx, y: ends.sy };
  const b = { x: ends.tx, y: ends.ty };
  const blocked = obstacles.some((o) => segmentHitsRect(a, b, inflate(o, HIT_MARGIN)));
  if (!blocked) return CURVE;

  const vertical = ends.sourceSide === 'top' || ends.sourceSide === 'bottom';
  if (vertical) {
    // Run down the right or the left of everything between the two cards.
    const lo = Math.min(source.y + source.h / 2, target.y + target.h / 2);
    const hi = Math.max(source.y + source.h / 2, target.y + target.h / 2);
    const mid = (source.x + source.w / 2 + target.x + target.w / 2) / 2;
    const right = clearLine(
      Math.max(source.x + source.w, target.x + target.w) + DETOUR_GAP,
      1,
      true,
      lo,
      hi,
      obstacles,
    );
    const left = clearLine(Math.min(source.x, target.x) - DETOUR_GAP, -1, true, lo, hi, obstacles);
    return Math.abs(right - mid) <= Math.abs(mid - left)
      ? { kind: 'detour', side: 'right', at: right }
      : { kind: 'detour', side: 'left', at: left };
  }
  const lo = Math.min(source.x + source.w / 2, target.x + target.w / 2);
  const hi = Math.max(source.x + source.w / 2, target.x + target.w / 2);
  const mid = (source.y + source.h / 2 + target.y + target.h / 2) / 2;
  const below = clearLine(
    Math.max(source.y + source.h, target.y + target.h) + DETOUR_GAP,
    1,
    false,
    lo,
    hi,
    obstacles,
  );
  const above = clearLine(Math.min(source.y, target.y) - DETOUR_GAP, -1, false, lo, hi, obstacles);
  return Math.abs(above - mid) <= Math.abs(below - mid)
    ? { kind: 'detour', side: 'top', at: above }
    : { kind: 'detour', side: 'bottom', at: below };
}

/** A stable string for a route, so components re-render only when it changes. */
export function routeKey(route: Route): string {
  return route.kind === 'curve' ? 'curve' : `${route.side}:${Math.round(route.at)}`;
}

export function parseRouteKey(key: string): Route {
  const [side, at] = key.split(':');
  if (side === 'top' || side === 'right' || side === 'bottom' || side === 'left') {
    const value = Number(at);
    if (Number.isFinite(value)) return { kind: 'detour', side, at: value };
  }
  return CURVE;
}

/** Points joined by straight runs with rounded corners. */
export function roundedPath(points: readonly XY[], radius: number): string {
  const first = points[0];
  if (!first) return '';
  let d = `M${first.x} ${first.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1] as XY;
    const corner = points[i] as XY;
    const next = points[i + 1] as XY;
    const inLen = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLen = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r <= 0) {
      d += `L${corner.x} ${corner.y}`;
      continue;
    }
    const before = {
      x: corner.x - ((corner.x - prev.x) / inLen) * r,
      y: corner.y - ((corner.y - prev.y) / inLen) * r,
    };
    const after = {
      x: corner.x + ((next.x - corner.x) / outLen) * r,
      y: corner.y + ((next.y - corner.y) / outLen) * r,
    };
    d += `L${before.x} ${before.y}Q${corner.x} ${corner.y} ${after.x} ${after.y}`;
  }
  const last = points[points.length - 1] as XY;
  return `${d}L${last.x} ${last.y}`;
}

/** The path and label position for a detour route. */
export function detourPath(
  source: Rect,
  target: Rect,
  route: Extract<Route, { kind: 'detour' }>,
  radius = 10,
): { path: string; labelX: number; labelY: number } {
  const { side, at } = route;
  const anchor = (r: Rect): XY => {
    switch (side) {
      case 'right':
        return { x: r.x + r.w, y: r.y + r.h / 2 };
      case 'left':
        return { x: r.x, y: r.y + r.h / 2 };
      case 'top':
        return { x: r.x + r.w / 2, y: r.y };
      case 'bottom':
        return { x: r.x + r.w / 2, y: r.y + r.h };
    }
  };
  const s = anchor(source);
  const t = anchor(target);
  const vertical = side === 'left' || side === 'right';
  const points = vertical
    ? [s, { x: at, y: s.y }, { x: at, y: t.y }, t]
    : [s, { x: s.x, y: at }, { x: t.x, y: at }, t];
  return {
    path: roundedPath(points, radius),
    labelX: vertical ? at : (s.x + t.x) / 2,
    labelY: vertical ? (s.y + t.y) / 2 : at,
  };
}
