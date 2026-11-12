import { FRAME_PADDING } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import {
  absoluteRect,
  CLEAR_GAP,
  clearSpot,
  commonFrame,
  frameAt,
  framesToGrow,
  landingInFrame,
  type Placement,
  reparentPosition,
  toCanvasSpace,
  toParentSpace,
  topLevelOf,
} from './geometry.js';

function map(...items: Placement[]) {
  return new Map(items.map((p) => [p.id, p]));
}

const outer: Placement = { id: 'outer', x: 100, y: 100, w: 800, h: 600, frame: true };
const inner: Placement = {
  id: 'inner',
  parent: 'outer',
  x: 40,
  y: 60,
  w: 400,
  h: 300,
  frame: true,
};
const card: Placement = { id: 'card', parent: 'inner', x: 32, y: 56, w: 264, h: 64, frame: false };
const loose: Placement = { id: 'loose', x: 1000, y: 100, w: 264, h: 64, frame: false };
const board = map(outer, inner, card, loose);

describe('geometry', () => {
  it('resolves absolute rectangles through nested frames', () => {
    expect(absoluteRect('card', board)).toEqual({ x: 172, y: 216, w: 264, h: 64 });
    expect(absoluteRect('inner', board)).toEqual({ x: 140, y: 160, w: 400, h: 300 });
  });

  it('converts between canvas and parent space both ways', () => {
    const point = { x: 500, y: 400 };
    const rel = toParentSpace(point, 'inner', board);
    expect(rel).toEqual({ x: 360, y: 240 });
    expect(toCanvasSpace(rel, 'inner', board)).toEqual(point);
  });

  it('keeps a node in place when moving it out of nested frames', () => {
    // card is drawn at (172, 216); at the root it must say exactly that.
    expect(reparentPosition('card', undefined, board)).toEqual({ x: 172, y: 216 });
  });

  it('keeps a node in place when moving it into a nested frame', () => {
    // loose is drawn at (1000, 100); relative to inner (at 140, 160) that is (860, -60).
    expect(reparentPosition('loose', 'inner', board)).toEqual({ x: 860, y: -60 });
  });

  it('keeps a node in place when moving between sibling depths', () => {
    expect(reparentPosition('card', 'outer', board)).toEqual({ x: 72, y: 116 });
  });

  it('finds the innermost frame under a point and skips excluded subtrees', () => {
    expect(frameAt({ x: 200, y: 200 }, board)).toBe('inner');
    expect(frameAt({ x: 800, y: 600 }, board)).toBe('outer');
    expect(frameAt({ x: 5, y: 5 }, board)).toBeUndefined();
    expect(frameAt({ x: 200, y: 200 }, board, new Set(['inner']))).toBe('outer');
    // a frame can never be a drop target for itself or anything inside it
    expect(frameAt({ x: 200, y: 200 }, board, new Set(['outer']))).toBeUndefined();
  });

  it('finds the common frame and the top level of a selection', () => {
    expect(commonFrame(['card', 'inner'], board)).toBe('outer');
    expect(commonFrame(['card'], board)).toBe('inner');
    expect(commonFrame(['card', 'loose'], board)).toBeUndefined();
    expect(topLevelOf(['card', 'inner', 'loose'], board)).toEqual(['inner', 'loose']);
  });

  it('grows frames to fit children and propagates outward', () => {
    const moved = map(outer, inner, { ...card, x: 380, y: 280 }, loose);
    const grown = framesToGrow(['inner'], moved);
    // 380 + 264 + 32 = 676, 280 + 64 + 32 = 376
    expect(grown.get('inner')).toEqual({ w: 676, h: 376 });
    // inner now ends at 40 + 676 + 32 = 748 < 800, so outer is fine
    expect(grown.has('outer')).toBe(false);
    const far = map(outer, inner, { ...card, x: 900, y: 20 }, loose);
    const both = framesToGrow(['inner'], far);
    expect(both.get('inner')?.w).toBe(1196);
    expect(both.get('outer')?.w).toBe(40 + 1196 + 32);
  });
});

describe('dropping at a frame edge', () => {
  const frame: Placement = { id: 'f', x: 0, y: 0, w: 900, h: 600, frame: true };
  const sibling: Placement = {
    id: 's',
    parent: 'f',
    x: FRAME_PADDING.left,
    y: FRAME_PADDING.top,
    w: 264,
    h: 96,
    frame: false,
  };
  const map = new Map<string, Placement>([
    ['f', frame],
    ['s', sibling],
  ]);
  const size = { w: 264, h: 64 };

  it('leaves a drop that is free after clamping where it lands', () => {
    expect(landingInFrame({ x: 400, y: -20, ...size }, 'f', map)).toEqual({
      x: 400,
      y: FRAME_PADDING.top,
    });
  });

  it('nudges a clamped drop off the sibling it would cover, to the nearest free spot', () => {
    const spot = landingInFrame({ x: -40, y: 80, ...size }, 'f', map);
    // Straight below the sibling is closer than beside it.
    expect(spot).toEqual({
      x: FRAME_PADDING.left,
      y: FRAME_PADDING.top + sibling.h + CLEAR_GAP,
    });
    const placed = { ...spot, ...size };
    expect(placed.y >= sibling.y + sibling.h || placed.x >= sibling.x + sibling.w).toBe(true);
  });

  it('never leaves the padded content box while searching', () => {
    const spot = landingInFrame({ x: 10, y: 10, ...size }, 'f', map);
    expect(spot.x).toBeGreaterThanOrEqual(FRAME_PADDING.left);
    expect(spot.y).toBeGreaterThanOrEqual(FRAME_PADDING.top);
  });

  it('does not nudge a drop made fully inside the frame, even onto a sibling', () => {
    expect(landingInFrame({ x: 48, y: 64, ...size }, 'f', map)).toEqual({ x: 48, y: 64 });
  });

  it('ignores the nodes being dragged', () => {
    expect(landingInFrame({ x: -40, y: 80, ...size }, 'f', map, new Set(['s']))).toEqual({
      x: FRAME_PADDING.left,
      y: 80,
    });
  });

  it('finds the nearest gap between several siblings', () => {
    const others = [
      { x: 32, y: 56, w: 200, h: 80 },
      { x: 32, y: 144, w: 200, h: 80 },
      { x: 248, y: 56, w: 200, h: 200 },
    ];
    const spot = clearSpot({ x: 32, y: 56, w: 200, h: 80 }, others);
    const rect = { ...spot, w: 200, h: 80 };
    for (const o of others) {
      const apart =
        rect.x >= o.x + o.w + CLEAR_GAP ||
        rect.x + rect.w + CLEAR_GAP <= o.x ||
        rect.y >= o.y + o.h + CLEAR_GAP ||
        rect.y + rect.h + CLEAR_GAP <= o.y;
      expect(apart).toBe(true);
    }
  });
});
