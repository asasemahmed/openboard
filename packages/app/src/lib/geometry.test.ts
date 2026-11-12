import { describe, expect, it } from 'vitest';
import {
  absoluteRect,
  commonFrame,
  frameAt,
  framesToGrow,
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
