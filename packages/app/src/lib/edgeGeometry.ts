/**
 * Floating edge endpoints: an edge leaves and enters a card on the sides that
 * face each other, so edges stay readable whatever the layout engine does.
 */
import type { Rect } from './geometry.js';

export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface EdgeEnds {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  sourceSide: Side;
  targetSide: Side;
}

export function edgeEnds(source: Rect, target: Rect): EdgeEnds {
  const scx = source.x + source.w / 2;
  const scy = source.y + source.h / 2;
  const tcx = target.x + target.w / 2;
  const tcy = target.y + target.h / 2;
  const dx = tcx - scx;
  const dy = tcy - scy;
  // Compare gaps between the boxes, not centre offsets, so wide cards prefer vertical routes.
  const gapX = Math.max(0, Math.abs(dx) - (source.w + target.w) / 2);
  const gapY = Math.max(0, Math.abs(dy) - (source.h + target.h) / 2);
  const horizontal = gapX > gapY;
  if (horizontal) {
    const sourceSide: Side = dx >= 0 ? 'right' : 'left';
    const targetSide: Side = dx >= 0 ? 'left' : 'right';
    return {
      sx: dx >= 0 ? source.x + source.w : source.x,
      sy: scy,
      tx: dx >= 0 ? target.x : target.x + target.w,
      ty: tcy,
      sourceSide,
      targetSide,
    };
  }
  const sourceSide: Side = dy >= 0 ? 'bottom' : 'top';
  const targetSide: Side = dy >= 0 ? 'top' : 'bottom';
  return {
    sx: scx,
    sy: dy >= 0 ? source.y + source.h : source.y,
    tx: tcx,
    ty: dy >= 0 ? target.y : target.y + target.h,
    sourceSide,
    targetSide,
  };
}
