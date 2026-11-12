import { describe, expect, it, vi } from 'vitest';
import { AGENT, ME, sampleDoc } from '../test/fixtures.js';
import { BoardStore } from './boardStore.js';

function setup() {
  const doc = sampleDoc();
  const store = new BoardStore(doc);
  return { doc, store };
}

describe('BoardStore', () => {
  it('derives flow nodes and edges from the document', () => {
    const { store } = setup();
    expect(store.nodes.map((n) => n.id).sort()).toEqual([
      'inner',
      'note1',
      'outer',
      'risk1',
      'task1',
    ]);
    expect(store.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
    expect(store.meta.meta.name).toBe('Checkout');
  });

  it('updates only the touched node and keeps the others identical', () => {
    const { store } = setup();
    const before = new Map(store.nodes.map((n) => [n.id, n]));
    const listener = vi.fn();
    store.subscribe(listener);
    const outcome = store.apply(
      [{ op: 'update_node', id: 'risk1', patch: { title: 'Charged twice' } }],
      ME,
    );
    expect(outcome.ok).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    for (const n of store.nodes) {
      if (n.id === 'risk1') {
        expect(n).not.toBe(before.get('risk1'));
        expect(n.data.node.title).toBe('Charged twice');
      } else {
        expect(n).toBe(before.get(n.id));
      }
    }
    // edges were not touched by a node title change
    expect(store.edges.find((e) => e.id === 'e1')).toBeDefined();
  });

  it('reorders when a node changes parent so frames stay first', () => {
    const { store } = setup();
    store.apply(
      [
        { op: 'update_node', id: 'note1', patch: { parent: 'inner' } },
        { op: 'move_node', id: 'note1', view: { x: 40, y: 60 } },
      ],
      ME,
    );
    const ids = store.nodes.map((n) => n.id);
    expect(store.flowNode('note1')?.parentId).toBe('inner');
    expect(ids.indexOf('inner')).toBeLessThan(ids.indexOf('note1'));
  });

  it('follows changes made by someone else (remote transactions)', () => {
    const { doc, store } = setup();
    doc.apply([{ op: 'add_node', id: 'q1', node: { type: 'question', title: 'Which gateway?' } }], {
      actor: AGENT,
    });
    expect(store.node('q1')?.title).toBe('Which gateway?');
    doc.apply([{ op: 'remove_node', id: 'risk1' }], { actor: AGENT });
    expect(store.node('risk1')).toBeUndefined();
    expect(store.edges.map((e) => e.id)).toEqual([]);
  });

  it('reparents children in the view when their frame is removed', () => {
    const { doc, store } = setup();
    doc.apply([{ op: 'remove_node', id: 'outer' }], { actor: AGENT });
    expect(store.flowNode('inner')?.parentId).toBeUndefined();
    expect(store.flowNode('task1')?.parentId).toBe('inner');
  });

  it('tracks selection, reports every change, and prunes removed ids', () => {
    const { doc, store } = setup();
    const seen: Array<{ nodeIds: readonly string[]; edgeIds: readonly string[] }> = [];
    store.onSelectionChange((s) => seen.push(s));
    store.select(['risk1', 'note1'], ['e1']);
    expect(store.selection).toEqual({ nodeIds: ['note1', 'risk1'], edgeIds: ['e1'] });
    expect(store.flowNode('risk1')?.selected).toBe(true);
    doc.apply([{ op: 'remove_node', id: 'risk1' }], { actor: AGENT });
    // risk1 and the edges touching it are gone from the selection
    expect(store.selection).toEqual({ nodeIds: ['note1'], edgeIds: [] });
    store.clearSelection();
    expect(store.selection).toEqual({ nodeIds: [], edgeIds: [] });
    expect(seen.map((s) => s.nodeIds.length)).toEqual([2, 1, 0]);
  });

  it('applies React Flow selection and drag changes without writing to the document', () => {
    const { doc, store } = setup();
    const before = doc.getNode('note1')?.view;
    store.onNodesChange([{ type: 'select', id: 'note1', selected: true }]);
    expect(store.selection.nodeIds).toEqual(['note1']);
    store.onNodesChange([
      { type: 'position', id: 'note1', position: { x: 400, y: 400 }, dragging: true },
    ]);
    expect(store.flowNode('note1')?.position).toEqual({ x: 400, y: 400 });
    expect(store.placements().get('note1')).toMatchObject({ x: 400, y: 400 });
    expect(doc.getNode('note1')?.view).toEqual(before);
    store.resetTransient(['note1']);
    expect(store.flowNode('note1')?.position).toEqual({ x: 0, y: 0 });
    expect(store.flowNode('note1')?.selected).toBe(true);
  });

  it('shows a ghost layer that does not count as board content', () => {
    const { store } = setup();
    const risk = store.node('risk1');
    if (!risk) throw new Error('missing');
    store.setGhosts({
      nodes: [{ ...risk, id: 'g1', title: 'Proposed' }],
      edges: [
        {
          ...(store.edge('e1') as NonNullable<ReturnType<BoardStore['edge']>>),
          id: 'ge1',
          source: 'g1',
        },
      ],
    });
    expect(store.nodes.find((n) => n.id === 'g1')?.data.ghost).toBe(true);
    expect(store.edges.find((e) => e.id === 'ge1')?.data?.ghost).toBe(true);
    expect(store.placements().has('g1')).toBe(false);
    store.setGhosts({ nodes: [], edges: [] });
    expect(store.nodes.find((n) => n.id === 'g1')).toBeUndefined();
  });
});
