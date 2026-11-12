/** Placing a floating control next to something on the canvas, in screen pixels. */
import type { Rect } from './geometry.js';

export interface Size {
  w: number;
  h: number;
}

const MARGIN = 8;
/** Room left above the target for its group label. */
const LABEL_ROOM = 24;
const GAP = 10;

/**
 * Where a control of `size` goes for a `target` in a `view` of the given
 * size: below the target (so it never covers the titles at the top of the
 * cards), above it when there is no room below, and clamped to stay visible
 * while the target is partly off-screen. Null when the target is entirely
 * out of view.
 */
export function placeControl(
  target: Rect,
  view: Size,
  size: Size,
): { left: number; top: number } | null {
  const visible =
    target.x < view.w && target.y < view.h && target.x + target.w > 0 && target.y + target.h > 0;
  if (!visible) return null;
  const clampX = (x: number) => Math.max(MARGIN, Math.min(x, view.w - size.w - MARGIN));
  const clampY = (y: number) => Math.max(MARGIN, Math.min(y, view.h - size.h - MARGIN));
  const below = target.y + target.h + GAP;
  const above = target.y - LABEL_ROOM - GAP - size.h;
  let top: number;
  if (below + size.h <= view.h - MARGIN) top = below;
  else if (above >= MARGIN) top = above;
  else top = clampY(below);
  return { left: clampX(target.x), top: Math.max(MARGIN, top) };
}

/** A canvas rect in screen pixels for a React Flow transform `[tx, ty, zoom]`. */
export function toScreen(rect: Rect, [tx, ty, zoom]: readonly [number, number, number]): Rect {
  return { x: rect.x * zoom + tx, y: rect.y * zoom + ty, w: rect.w * zoom, h: rect.h * zoom };
}

const STACK_GAP = 8;

/**
 * Place several controls at once: each as `placeControl` would, then moved
 * down past any control placed before it that it would cover, so two
 * proposals side by side never hide each other's buttons.
 */
export function placeControls(
  targets: readonly Rect[],
  view: Size,
  size: Size,
): Array<{ left: number; top: number } | null> {
  const placed: Array<{ left: number; top: number }> = [];
  return targets.map((target) => {
    const at = placeControl(target, view, size);
    if (!at) return null;
    let top = at.top;
    for (let guard = 0; guard < targets.length; guard++) {
      const hit = placed.find(
        (p) =>
          Math.abs(p.left - at.left) < size.w &&
          top < p.top + size.h + STACK_GAP &&
          top + size.h + STACK_GAP > p.top,
      );
      if (!hit) break;
      top = hit.top + size.h + STACK_GAP;
    }
    const next = { left: at.left, top };
    placed.push(next);
    return next;
  });
}
