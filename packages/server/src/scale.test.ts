import type { Actor } from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeRoot, startTestServer, tempRoot } from './testing.js';
import type { OpenBoardServer } from './types.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };

let root: string;
let server: OpenBoardServer;

beforeEach(async () => {
  root = await tempRoot();
  server = await startTestServer(root);
  await server.api(ADA).createBoard({ name: 'Plan' });
});

afterEach(async () => {
  await server.close();
  await removeRoot(root);
});

/** A Mermaid chart of `n` nodes in chains of ten, with a few subgraphs. */
function chart(n: number): string {
  const lines = ['flowchart TD'];
  for (let i = 0; i < n; i++) {
    if (i % 100 === 0) lines.push(`  subgraph G${i}[Group ${i}]`);
    lines.push(`    N${i}[Node ${i}]`);
    if (i % 100 === 99 || i === n - 1) lines.push('  end');
  }
  for (let i = 1; i < n; i++) if (i % 10 !== 0) lines.push(`  N${i - 1} --> N${i}`);
  return lines.join('\n');
}

describe('large batches', () => {
  for (const n of [600, 2000]) {
    it(`imports and places ${n} nodes in one batch`, { timeout: 120_000 }, async () => {
      const api = server.api(ADA);
      const started = Date.now();
      const result = await api.importInto('plan', { text: chart(n) });
      expect(result.status).toBe('applied');
      expect(result.warnings).toEqual([]);
      const board = await api.getBoard('plan');
      const nodes = Object.values(board.nodes);
      expect(nodes.length).toBe(n + Math.ceil(n / 100));
      expect(nodes.filter((node) => !node.view)).toEqual([]);
      // One batch: undo takes it all back.
      const history = await api.history('plan', { includeMoves: true });
      expect(history.batches).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(90_000);
    });
  }

  it('lays out more than 500 unplaced nodes, and places what an earlier apply left', {
    timeout: 60_000,
  }, async () => {
    const api = server.api(ADA);
    for (let chunk = 0; chunk < 2; chunk++) {
      const ops = Array.from({ length: 350 }, (_, i) => ({
        op: 'add_node' as const,
        node: { type: 'note' as const, title: `Loose ${chunk}-${i}` },
      }));
      const result = await api.apply('plan', { layout: 'none', ops });
      expect(result.status).toBe('applied');
    }
    const moved = await api.layout('plan');
    expect(moved.moved).toBe(700);
    expect(Object.values((await api.getBoard('plan')).nodes).filter((n) => !n.view)).toEqual([]);

    await api.apply('plan', {
      layout: 'none',
      ops: [{ op: 'add_node', node: { type: 'note', title: 'Late' } }],
    });
    const next = await api.apply('plan', {
      ops: [{ op: 'add_node', node: { type: 'note', title: 'Next' } }],
    });
    expect(next.warnings).toBeUndefined();
    expect(Object.values((await api.getBoard('plan')).nodes).filter((n) => !n.view)).toEqual([]);
  });
});
