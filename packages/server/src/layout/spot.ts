/**
 * Finding a free spot for one rectangle among fixed obstacles.
 */
import { NODE_GAP, snap } from '@openboard/core';
import { ceilToGrid, floorToGrid, type Rect, type Size } from './geometry.js';

export type Axis = 'x' | 'y';

export interface SpotQuery {
  /** Preferred top-left corner. */
  ideal: { x: number; y: number };
  size: Size;
  /** Rectangles to keep `NODE_GAP` away from. */
  obstacles: readonly Rect[];
  /** Smallest allowed coordinates (a frame's padding). */
  min?: { x: number; y: number };
  /**
   * The flow axis. Candidates are scanned level by level along it, and moving
   * one step along it costs `mainWeight` steps across it.
   */
  main: Axis;
  mainWeight: number;
  /** When set, the main coordinate must stay on this side of the ideal (1: at or after, -1: at or before). */
  side?: 1 | -1;
}

interface Span {
  start: number;
  size: number;
}

const other = (axis: Axis): Axis => (axis === 'x' ? 'y' : 'x');
const extent = (axis: Axis): 'w' | 'h' => (axis === 'x' ? 'w' : 'h');

function span(rect: Rect, axis: Axis): Span {
  return { start: rect[axis], size: rect[extent(axis)] };
}

/**
 * Candidate coordinates on one axis: the ideal, plus just after and just
 * before every obstacle (with the gap), rounded away from the obstacle onto the
 * grid. The nearest free coordinate along a line is always one of these.
 */
function candidates(
  ideal: number,
  size: number,
  spans: readonly Span[],
  gap: number,
  min: number,
  side: 1 | -1 | undefined,
): number[] {
  const values = new Set<number>([ideal]);
  let farEnd = ideal;
  for (const s of spans) {
    const after = ceilToGrid(s.start + s.size + gap);
    values.add(after);
    values.add(floorToGrid(s.start - size - gap));
    farEnd = Math.max(farEnd, after);
  }
  // Past every obstacle is always free; keep it even when the side rule
  // or the minimum removes everything else.
  values.add(Math.max(farEnd, ceilToGrid(min)));
  return [...values]
    .filter((v) => v >= min && (side === undefined || (side === 1 ? v >= ideal : v <= ideal)))
    .sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal) || b - a);
}

function clear(start: number, size: number, spans: readonly Span[], gap: number): boolean {
  for (const s of spans) {
    if (start < s.start + s.size + gap && s.start < start + size + gap) return false;
  }
  return true;
}

/**
 * The free top-left corner closest to `ideal`, keeping `NODE_GAP` from every
 * obstacle. Distance is measured in steps of the rectangle's own size plus the
 * gap on each axis, with main-axis steps weighted by `mainWeight`. Ties go to
 * the larger coordinate, so several rectangles aimed at one spot fan out
 * around it. All returned coordinates are on the grid.
 */
export function findFreeSpot(query: SpotQuery): { x: number; y: number } {
  const { main, size, obstacles, mainWeight, side } = query;
  const cross = other(main);
  const minMain = query.min?.[main] ?? Number.NEGATIVE_INFINITY;
  const minCross = query.min?.[cross] ?? Number.NEGATIVE_INFINITY;
  const gapMain = NODE_GAP[main];
  const gapCross = NODE_GAP[cross];
  const sizeMain = size[extent(main)];
  const sizeCross = size[extent(cross)];
  let idealMain = Math.max(snap(query.ideal[main]), ceilToGrid(minMain));
  const idealCross = Math.max(snap(query.ideal[cross]), ceilToGrid(minCross));
  let mainSide = side;
  if (mainSide === -1 && idealMain > snap(query.ideal[main])) mainSide = undefined;
  if (mainSide === 1) idealMain = Math.max(idealMain, snap(query.ideal[main]));

  const stepMain = sizeMain + gapMain;
  const stepCross = sizeCross + gapCross;
  const mainSpans = obstacles.map((o) => span(o, main));
  const levels = candidates(idealMain, sizeMain, mainSpans, gapMain, minMain, mainSide);

  let best: { main: number; cross: number; cost: number } | undefined;
  for (const level of levels) {
    const levelCost = (Math.abs(level - idealMain) / stepMain) * mainWeight;
    if (best && levelCost >= best.cost) break;
    // Only obstacles in this band can block a spot on this level.
    const band: Span[] = [];
    for (const o of obstacles) {
      const m = span(o, main);
      if (level < m.start + m.size + gapMain && m.start < level + sizeMain + gapMain) {
        band.push(span(o, cross));
      }
    }
    for (const c of candidates(idealCross, sizeCross, band, gapCross, minCross, undefined)) {
      const cost = levelCost + Math.abs(c - idealCross) / stepCross;
      if (best && cost >= best.cost) break;
      if (clear(c, sizeCross, band, gapCross)) {
        best = { main: level, cross: c, cost };
        break;
      }
    }
  }
  // `levels` always holds a coordinate past every obstacle, so `best` is set.
  const chosen = best ?? { main: idealMain, cross: idealCross };
  return main === 'x' ? { x: chosen.main, y: chosen.cross } : { x: chosen.cross, y: chosen.main };
}
