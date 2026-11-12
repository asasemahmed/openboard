import { describe, expect, it } from 'vitest';
import { sampleDoc } from '../test/fixtures.js';
import { boardToFlow, placementsOf } from './flow.js';
import type { Placement, PlacementMap } from './geometry.js';
import { neighborInDirection, readingOrder, stepInOrder } from './keyboardNav.js';

function sampleMap(): PlacementMap {
  const doc = sampleDoc();
  return placementsOf(boardToFlow(doc.nodes(), doc.edges()).nodes);
}

function grid(items: Array<[string, number, number, string?]>): PlacementMap {
  const map = new Map<string, Placement>();
  for (const [id, x, y, parent] of items) {
    const p: Placement = { id, x, y, w: 200, h: 80, frame: id.startsWith('frame') };
    if (parent) p.parent = parent;
    map.set(id, p);
  }
  return map;
}

describe('readingOrder', () => {
  it('reads rows top to bottom, a frame followed by its contents', () => {
    expect(readingOrder(sampleMap())).toEqual(['note1', 'outer', 'inner', 'task1', 'risk1']);
  });

  it('keeps slightly offset cards in one row', () => {
    const map = grid([
      ['c', 520, 4],
      ['a', 0, 10],
      ['b', 260, 0],
      ['d', 0, 140],
      ['e', 260, 130],
    ]);
    expect(readingOrder(map)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('treats a node whose frame is missing as top-level', () => {
    const map = grid([
      ['a', 0, 0, 'gone'],
      ['b', 300, 0],
    ]);
    expect(readingOrder(map)).toEqual(['a', 'b']);
  });
});

describe('stepInOrder', () => {
  it('steps forward and back and stops at the ends', () => {
    const order = ['a', 'b', 'c'];
    expect(stepInOrder(order, 'a', 1)).toBe('b');
    expect(stepInOrder(order, 'b', -1)).toBe('a');
    expect(stepInOrder(order, 'c', 1)).toBeUndefined();
    expect(stepInOrder(order, null, 1)).toBe('a');
    expect(stepInOrder(order, null, -1)).toBe('c');
  });
});

describe('neighborInDirection', () => {
  const map = grid([
    ['a', 0, 0],
    ['b', 300, 0],
    ['c', 300, 200],
    ['d', 0, 200],
    ['far', 900, 20],
  ]);

  it('prefers nodes in line over nearer ones off to the side', () => {
    expect(neighborInDirection('a', 'right', map)).toBe('b');
    expect(neighborInDirection('a', 'down', map)).toBe('d');
    expect(neighborInDirection('c', 'up', map)).toBe('b');
    expect(neighborInDirection('c', 'left', map)).toBe('d');
    expect(neighborInDirection('b', 'right', map)).toBe('far');
    expect(neighborInDirection('a', 'up', map)).toBeUndefined();
  });

  it('never lands on a frame that contains the node', () => {
    const nested = sampleMap();
    expect(neighborInDirection('task1', 'up', nested)).toBe('note1');
    expect(neighborInDirection('task1', 'right', nested)).toBe('risk1');
  });
});
