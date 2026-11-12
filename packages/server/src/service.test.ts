import type { Actor } from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findOverlaps } from './layout/index.js';
import { removeRoot, startTestServer, tempRoot } from './testing.js';
import type { OpenBoardServer } from './types.js';

const AGENT: Actor = { id: 'helper', kind: 'agent', name: 'Helper' };

let root: string;
let server: OpenBoardServer;

beforeEach(async () => {
  root = await tempRoot();
  server = await startTestServer(root);
  await server.api(AGENT).createBoard({ name: 'Plan' });
});

afterEach(async () => {
  await server.close();
  await removeRoot(root);
});

describe('layout on apply', () => {
  it('gives every new node a view without overlaps, attributed to the caller as moves', async () => {
    const api = server.api(AGENT);
    const result = await api.apply('plan', {
      ops: [
        { op: 'add_node', ref: 'f', node: { type: 'frame', title: 'Frame' } },
        { op: 'add_node', ref: 'a', node: { type: 'task', title: 'A', parent: '$f' } },
        { op: 'add_node', ref: 'b', node: { type: 'task', title: 'B', parent: '$f' } },
        { op: 'add_node', ref: 'c', node: { type: 'note', title: 'C' } },
        { op: 'add_node', ref: 'd', node: { type: 'note', title: 'D' } },
        { op: 'add_edge', edge: { type: 'depends_on', source: '$b', target: '$a' } },
      ],
    });
    expect(result.status).toBe('applied');
    const board = await api.getBoard('plan');
    for (const node of Object.values(board.nodes)) {
      expect(node.view, node.title).toBeDefined();
      expect(node.view?.pinned).toBeUndefined();
    }
    expect(findOverlaps(board)).toEqual([]);

    const feed = await api.changes('plan', { since: 0, includeOwn: true, includeMoves: true });
    expect(feed.changes.some((c) => c.kind === 'node_moved' && c.actor === 'helper')).toBe(true);
    expect(feed.cursor).toBe(result.cursor);
  });

  it('leaves views alone with layout "none"', async () => {
    const api = server.api(AGENT);
    await api.apply('plan', {
      layout: 'none',
      ops: [
        { op: 'add_node', id: 'n_free', node: { type: 'note', title: 'Free' } },
        {
          op: 'add_node',
          id: 'n_placed',
          node: { type: 'note', title: 'Placed', view: { x: 1000, y: 1000 } },
        },
      ],
    });
    const board = await api.getBoard('plan');
    expect(board.nodes.n_free?.view).toBeUndefined();
    expect(board.nodes.n_placed?.view).toEqual({ x: 1000, y: 1000 });
  });

  it('layout() re-arranges the board and reports how many nodes moved', async () => {
    const api = server.api(AGENT);
    await api.apply('plan', {
      layout: 'none',
      ops: [
        { op: 'add_node', id: 'n_1', node: { type: 'note', title: 'One', view: { x: 0, y: 0 } } },
        { op: 'add_node', id: 'n_2', node: { type: 'note', title: 'Two', view: { x: 0, y: 0 } } },
        {
          op: 'add_node',
          id: 'n_3',
          node: { type: 'note', title: 'Three', view: { x: 0, y: 0, pinned: true } },
        },
      ],
    });
    expect(findOverlaps(await api.getBoard('plan')).length).toBeGreaterThan(0);

    const result = await api.layout('plan');
    expect(result.moved).toBeGreaterThan(0);
    const board = await api.getBoard('plan');
    expect(findOverlaps(board)).toEqual([]);
    expect(board.nodes.n_3?.view).toEqual({ x: 0, y: 0, pinned: true });

    const all = await api.layout('plan', { scope: 'all', direction: 'right' });
    expect(all.cursor).toBeGreaterThanOrEqual(result.cursor);
    expect((await api.getBoard('plan')).nodes.n_3?.view?.pinned).not.toBe(true);
  });

  it('dry run reports the refs it would create without writing', async () => {
    const api = server.api(AGENT);
    const dry = await api.apply('plan', {
      dryRun: true,
      ops: [{ op: 'add_node', ref: 'x', node: { type: 'note', title: 'X' } }],
    });
    expect(dry.status).toBe('valid');
    expect(Object.keys(dry.refs)).toEqual(['x']);
    expect((await api.getBoard('plan')).nodes).toEqual({});
  });

  it('serializes concurrent applies so both land and are laid out', async () => {
    const api = server.api(AGENT);
    const batch = (prefix: string) =>
      api.apply('plan', {
        ops: [1, 2, 3].map((i) => ({
          op: 'add_node' as const,
          node: { type: 'note' as const, title: `${prefix}${i}` },
        })),
      });
    const results = await Promise.all([batch('a'), batch('b'), batch('c')]);
    expect(results.every((r) => r.status === 'applied')).toBe(true);
    const board = await api.getBoard('plan');
    expect(Object.keys(board.nodes)).toHaveLength(9);
    expect(findOverlaps(board)).toEqual([]);
  });
});
