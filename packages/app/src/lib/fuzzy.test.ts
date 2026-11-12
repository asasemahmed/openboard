import type { BoardNode } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { fuzzyScore, searchNodes } from './fuzzy.js';

function node(id: string, title: string, tags?: string[]): BoardNode {
  return {
    id,
    type: 'note',
    title,
    ...(tags ? { tags } : {}),
    createdBy: 'a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'a',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('fuzzyScore', () => {
  it('ranks exact > prefix > word substring > inner substring > subsequence', () => {
    const exact = fuzzyScore('retry', 'retry') ?? 0;
    const prefix = fuzzyScore('retry', 'retry logic') ?? 0;
    const word = fuzzyScore('retry', 'payment retry') ?? 0;
    const inner = fuzzyScore('etry', 'retry') ?? 0;
    const scattered = fuzzyScore('rtl', 'retry logic') ?? 0;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(scattered);
    expect(scattered).toBeGreaterThan(0);
  });

  it('rejects text that does not contain the characters in order', () => {
    expect(fuzzyScore('xyz', 'retry logic')).toBeNull();
    expect(fuzzyScore('lr', 'rl')).toBeNull();
  });

  it('prefers word starts in subsequences', () => {
    expect(fuzzyScore('pa', 'payment api') ?? 0).toBeGreaterThan(fuzzyScore('pa', 'spare') ?? 0);
  });
});

describe('searchNodes', () => {
  const nodes = [
    node('n_aaa111', 'Payment API'),
    node('n_bbb222', 'Retry logic', ['payments']),
    node('n_ccc333', 'Double charge on retry'),
    node('n_ddd444', 'Ship it'),
  ];

  it('finds by title and ranks the best match first', () => {
    const results = searchNodes(nodes, 'retry');
    expect(results.map((r) => r.node.id)).toEqual(['n_bbb222', 'n_ccc333']);
  });

  it('finds by exact id or id prefix', () => {
    expect(searchNodes(nodes, 'n_ddd444')[0]).toMatchObject({ field: 'id' });
    expect(searchNodes(nodes, 'n_ddd')[0]?.node.id).toBe('n_ddd444');
  });

  it('finds by tag, with or without #', () => {
    const byTag = searchNodes(nodes, '#payments');
    expect(byTag[0]?.node.id).toBe('n_bbb222');
    expect(byTag[0]?.field).toBe('tag');
  });

  it('returns nothing for an empty query', () => {
    expect(searchNodes(nodes, '  ')).toEqual([]);
  });
});
