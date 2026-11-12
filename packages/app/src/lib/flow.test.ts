import { defaultNodeSize, FRAME_MIN } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { sampleDoc } from '../test/fixtures.js';
import {
  boardToFlow,
  nodeSize,
  orderFlowNodes,
  placementsOf,
  toFlowEdge,
  toFlowNode,
} from './flow.js';

describe('board -> React Flow', () => {
  const doc = sampleDoc();
  const flow = boardToFlow(doc.nodes(), doc.edges(), { nodeIds: new Set(['task1']) });
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));

  it('keeps positions parent-relative and sets parentId', () => {
    const task = byId.get('task1');
    expect(task?.parentId).toBe('inner');
    expect(task?.position).toEqual({ x: 32, y: 56 });
    expect(byId.get('inner')?.parentId).toBe('outer');
    expect(byId.get('outer')?.parentId).toBeUndefined();
  });

  it('puts every frame before the nodes inside it', () => {
    const index = (id: string) => flow.nodes.findIndex((n) => n.id === id);
    expect(index('outer')).toBeLessThan(index('inner'));
    expect(index('inner')).toBeLessThan(index('task1'));
  });

  it('sizes nodes from view or from core defaults', () => {
    const risk = doc.getNode('risk1');
    if (!risk) throw new Error('missing');
    const expected = defaultNodeSize(risk);
    expect(byId.get('risk1')?.width).toBe(expected.w);
    expect(byId.get('risk1')?.height).toBe(expected.h);
    expect(byId.get('outer')?.width).toBe(800);
    expect(byId.get('outer')?.height).toBe(600);
    expect(nodeSize({ ...risk, type: 'frame', view: { x: 0, y: 0 } })).toEqual(FRAME_MIN);
  });

  it('maps frames and cards to their components and keeps selection', () => {
    expect(byId.get('outer')?.type).toBe('frame');
    expect(byId.get('outer')?.dragHandle).toBe('.frame-handle');
    expect(byId.get('task1')?.type).toBe('card');
    expect(byId.get('task1')?.selected).toBe(true);
    expect(byId.get('risk1')?.selected).toBe(false);
  });

  it('maps edges with their board data', () => {
    const edge = flow.edges.find((e) => e.id === 'e1');
    expect(edge).toMatchObject({ source: 'risk1', target: 'task1', type: 'board' });
    expect(edge?.data?.edge.type).toBe('blocks');
  });

  it('renders ghosts as non-interactive', () => {
    const risk = doc.getNode('risk1');
    if (!risk) throw new Error('missing');
    const ghost = toFlowNode({ ...risk, id: 'g1' }, { ghost: true });
    expect(ghost.data.ghost).toBe(true);
    expect(ghost.draggable).toBe(false);
    expect(ghost.className).toBe('is-ghost');
    const edge = doc.getEdge('e1');
    if (!edge) throw new Error('missing');
    expect(toFlowEdge(edge, { ghost: true }).selectable).toBe(false);
  });

  it('orders deep chains regardless of input order', () => {
    const ordered = orderFlowNodes([
      { id: 'c', parentId: 'b' },
      { id: 'b', parentId: 'a' },
      { id: 'x' },
      { id: 'a' },
    ]);
    expect(ordered.map((n) => n.id)).toEqual(['x', 'a', 'b', 'c']);
  });

  it('flattens to placements for geometry', () => {
    const map = placementsOf(flow.nodes);
    expect(map.get('task1')).toMatchObject({ parent: 'inner', x: 32, y: 56, frame: false });
    expect(map.get('outer')).toMatchObject({ frame: true, w: 800, h: 600 });
  });
});
