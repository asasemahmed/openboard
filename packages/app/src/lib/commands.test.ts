import { absolutePosition, FRAME_PADDING } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { ME, sampleDoc } from '../test/fixtures.js';
import { addNodeOps, duplicateOps, frameAroundOps, moveOps, removeOps } from './commands.js';
import { boardToFlow, placementsOf } from './flow.js';
import type { Placement } from './geometry.js';

function setup() {
  const doc = sampleDoc();
  const flow = boardToFlow(doc.nodes(), doc.edges());
  const map = new Map(placementsOf(flow.nodes));
  return { doc, map };
}

function drop(map: Map<string, Placement>, id: string, x: number, y: number) {
  const item = map.get(id);
  if (!item) throw new Error(`missing ${id}`);
  map.set(id, { ...item, x, y });
}

describe('moveOps', () => {
  it('reparents into a frame in one batch without moving the card on screen', () => {
    const { doc, map } = setup();
    // note1 sits at the root; drop it so its centre lands inside "inner" (canvas 140..540, 160..460).
    drop(map, 'note1', 200, 300);
    const ops = moveOps(['note1'], map);
    expect(ops.map((o) => o.op)).toEqual(['update_node', 'move_node']);
    expect(doc.apply(ops, { actor: ME }).ok).toBe(true);
    const note = doc.getNode('note1');
    expect(note?.parent).toBe('inner');
    expect(note?.view?.pinned).toBe(true);
    expect(absolutePosition(doc.toJSON(), 'note1')).toEqual({ x: 200, y: 300 });
  });

  it('moves a card out of nested frames to the root, keeping its canvas position', () => {
    const { doc, map } = setup();
    // task1 is relative to inner; put it far outside every frame (relative coords).
    drop(map, 'task1', 1200, 900);
    const before = { x: 100 + 40 + 1200, y: 100 + 60 + 900 };
    const ops = moveOps(['task1'], map);
    expect(doc.apply(ops, { actor: ME }).ok).toBe(true);
    expect(doc.getNode('task1')?.parent).toBeUndefined();
    expect(absolutePosition(doc.toJSON(), 'task1')).toEqual(before);
  });

  it('clamps into the padded content box and grows the frame', () => {
    const { doc, map } = setup();
    // centre stays inside "inner" (canvas x 140..540), but the top pokes into the title bar
    drop(map, 'task1', 200, 10);
    const ops = moveOps(['task1'], map);
    expect(doc.apply(ops, { actor: ME }).ok).toBe(true);
    const task = doc.getNode('task1');
    expect(task?.view?.y).toBe(FRAME_PADDING.top);
    expect(doc.getNode('inner')?.view?.w).toBe(200 + 264 + FRAME_PADDING.right);
  });

  it('writes only a move when the parent does not change', () => {
    const { map } = setup();
    drop(map, 'risk1', 1040, 160);
    expect(moveOps(['risk1'], map)).toEqual([
      { op: 'move_node', id: 'risk1', view: { x: 1040, y: 160, pinned: true } },
    ]);
  });
});

describe('other builders', () => {
  it('adds a node centred on a point, inside the frame under it', () => {
    const { doc, map } = setup();
    const ops = addNodeOps({ id: 'n_new', type: 'note', title: 'Hi', at: { x: 300, y: 300 } }, map);
    expect(doc.apply(ops, { actor: ME }).ok).toBe(true);
    expect(doc.getNode('n_new')?.parent).toBe('inner');
  });

  it('removes a frame keeping or cascading its children', () => {
    const keep = setup();
    const ops = removeOps(
      ['outer'],
      [],
      new Map(keep.doc.edges().map((e) => [e.id, e])),
      keep.map,
      'reparent',
    );
    expect(keep.doc.apply(ops, { actor: ME }).ok).toBe(true);
    expect(keep.doc.getNode('inner')?.parent).toBeUndefined();

    const all = setup();
    const cascade = removeOps(
      ['outer', 'task1'],
      ['e1'],
      new Map(all.doc.edges().map((e) => [e.id, e])),
      all.map,
      'cascade',
    );
    // task1 goes with the frame, and e1 with task1: neither is removed twice
    expect(cascade).toEqual([{ op: 'remove_node', id: 'outer', children: 'cascade' }]);
    expect(all.doc.apply(cascade, { actor: ME }).ok).toBe(true);
    expect(all.doc.getNode('task1')).toBeUndefined();
  });

  it('duplicates a frame with its contents and internal edges', () => {
    const { doc, map } = setup();
    let n = 0;
    const result = duplicateOps(
      ['inner', 'risk1'],
      new Map(doc.nodes().map((x) => [x.id, x])),
      doc.edges(),
      map,
      (prefix) => `${prefix}_copy${n++}`,
    );
    expect(doc.apply(result.ops, { actor: ME }).ok).toBe(true);
    expect(doc.nodes()).toHaveLength(5 + 3);
    expect(doc.edges()).toHaveLength(2 + 1);
    expect(result.ids).toHaveLength(2);
  });

  it('frames a selection without moving anything on screen', () => {
    const { doc, map } = setup();
    const before = absolutePosition(doc.toJSON(), 'task1');
    const ops = frameAroundOps(['task1'], map, 'n_frame');
    expect(doc.apply(ops, { actor: ME }).ok).toBe(true);
    expect(doc.getNode('task1')?.parent).toBe('n_frame');
    expect(doc.getNode('n_frame')?.parent).toBe('inner');
    expect(absolutePosition(doc.toJSON(), 'task1')).toEqual(before);
  });
});
