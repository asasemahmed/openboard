import type { Actor } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { isQuietEdge, quietCounts } from './connections.js';

const actors: Record<string, Actor> = {
  ada: { id: 'ada', kind: 'human', name: 'Ada' },
  planner: { id: 'planner', kind: 'agent', name: 'planner' },
  system: { id: 'system', kind: 'system', name: 'OpenBoard' },
};

describe('isQuietEdge', () => {
  it('holds back only what an agent made', () => {
    expect(isQuietEdge({ createdBy: 'planner' }, actors)).toBe(true);
    expect(isQuietEdge({ createdBy: 'ada' }, actors)).toBe(false);
    expect(isQuietEdge({ createdBy: 'system' }, actors)).toBe(false);
  });

  it('treats an unknown author as a person, and never reads inherited keys', () => {
    expect(isQuietEdge({ createdBy: 'nobody' }, actors)).toBe(false);
    expect(isQuietEdge({ createdBy: 'constructor' }, actors)).toBe(false);
  });
});

describe('quietCounts', () => {
  it('counts held-back connections at both ends', () => {
    const counts = quietCounts(
      [
        { createdBy: 'planner', source: 'a', target: 'b' },
        { createdBy: 'planner', source: 'b', target: 'c' },
        { createdBy: 'ada', source: 'a', target: 'c' },
      ],
      actors,
    );
    expect(Object.fromEntries(counts)).toEqual({ a: 1, b: 2, c: 1 });
  });
});
