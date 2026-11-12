import { describe, expect, it } from 'vitest';
import {
  chooseRoute,
  DETOUR_GAP,
  detourPath,
  parseRouteKey,
  routeKey,
  segmentHitsRect,
} from './edgeRoute.js';

const card = (x: number, y: number, w = 264, h = 96) => ({ x, y, w, h });

describe('segmentHitsRect', () => {
  it('detects crossing, touching nothing, and lines that stop short', () => {
    const r = card(100, 100, 100, 100);
    expect(segmentHitsRect({ x: 0, y: 150 }, { x: 300, y: 150 }, r)).toBe(true);
    expect(segmentHitsRect({ x: 0, y: 50 }, { x: 300, y: 50 }, r)).toBe(false);
    expect(segmentHitsRect({ x: 0, y: 150 }, { x: 90, y: 150 }, r)).toBe(false);
    expect(segmentHitsRect({ x: 150, y: 0 }, { x: 150, y: 400 }, r)).toBe(true);
  });
});

describe('chooseRoute', () => {
  const a = card(0, 0);
  const b = card(0, 200);
  const c = card(0, 400);

  it('keeps the curve when nothing is in the way', () => {
    expect(chooseRoute(a, b, [c])).toEqual({ kind: 'curve' });
    expect(chooseRoute(a, b, [])).toEqual({ kind: 'curve' });
  });

  it('runs beside a stacked column instead of under the middle card', () => {
    const route = chooseRoute(a, c, [b]);
    expect(route).toEqual({ kind: 'detour', side: 'right', at: 264 + DETOUR_GAP });
  });

  it('clears a wider card in the way', () => {
    const wide = card(-40, 200, 400, 96);
    const route = chooseRoute(a, c, [wide]);
    expect(route.kind).toBe('detour');
    if (route.kind !== 'detour') return;
    expect(route.at > 360 || route.at < -40).toBe(true);
  });

  it('goes over or under a card in the middle of a row', () => {
    const left = card(0, 0);
    const middle = card(320, 0);
    const right = card(640, 0);
    const route = chooseRoute(left, right, [middle]);
    expect(route.kind).toBe('detour');
    if (route.kind !== 'detour') return;
    expect(['top', 'bottom']).toContain(route.side);
  });

  it('draws the detour with its label off the cards', () => {
    const route = chooseRoute(a, c, [b]);
    if (route.kind !== 'detour') throw new Error('expected a detour');
    const { path, labelX, labelY } = detourPath(a, c, route);
    expect(path.startsWith('M264 48')).toBe(true);
    expect(path.endsWith('L264 448')).toBe(true);
    expect(labelX).toBe(264 + DETOUR_GAP);
    expect(labelY).toBe(248);
    expect(parseRouteKey(routeKey(route))).toEqual(route);
    expect(parseRouteKey('curve')).toEqual({ kind: 'curve' });
  });
});
