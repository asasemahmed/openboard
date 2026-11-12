import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { type Actor, applyOps, BoardDoc, type DocEvent, emptyBoard, type Op } from './index.js';

const ada: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const bot: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };
const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-02T00:00:00.000Z');
const T2 = new Date('2026-01-03T00:00:00.000Z');

function counter(start = 0) {
  let i = start;
  return (prefix: string) => `${prefix}_${++i}`;
}

function sync(a: BoardDoc, b: BoardDoc) {
  Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc, Y.encodeStateVector(b.ydoc)));
  Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc, Y.encodeStateVector(a.ydoc)));
}

function mustApply(doc: BoardDoc, ops: unknown[], actor: Actor = ada, now: Date = T1) {
  const result = doc.apply(ops as Op[], { actor, now, newId: counter(100) });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
}

const seedOps: Op[] = [
  { op: 'add_node', ref: 'f', node: { type: 'frame', title: 'Frame', view: { x: 0, y: 0 } } },
  { op: 'add_node', ref: 'a', node: { type: 'task', title: 'A', parent: '$f', status: 'todo' } },
  { op: 'add_node', ref: 'b', node: { type: 'note', title: 'B', tags: ['x'], body: 'text' } },
  { op: 'add_edge', edge: { type: 'relates_to', source: '$a', target: '$b' } },
];

function seededDoc() {
  const doc = BoardDoc.create({ id: 'main', name: 'Main' }, { now: T0 });
  mustApply(doc, seedOps);
  return doc;
}

describe('BoardDoc', () => {
  it('apply produces the same board as applyOps', () => {
    const doc = BoardDoc.create({ id: 'main', name: 'Main' }, { now: T0 });
    const pure = applyOps(emptyBoard({ id: 'main', name: 'Main' }, T0), seedOps, {
      actor: ada,
      now: T1,
      newId: counter(),
    });
    const live = doc.apply(seedOps, { actor: ada, now: T1, newId: counter() });
    expect(live).toEqual(pure);
    expect(pure.ok && doc.toJSON()).toEqual(pure.ok && pure.board);

    const more: Op[] = [
      { op: 'update_node', id: 'n_2', patch: { title: 'A2', status: null } },
      { op: 'move_node', id: 'n_3', view: { x: 4, y: 5 } },
      { op: 'remove_node', id: 'n_1' },
    ];
    const pure2 = pure.ok ? applyOps(pure.board, more, { actor: bot, now: T2 }) : pure;
    const live2 = doc.apply(more, { actor: bot, now: T2 });
    expect(live2).toEqual(pure2);
    expect(pure2.ok && doc.toJSON()).toEqual(pure2.ok && pure2.board);
    expect(doc.issues()).toEqual([]);
  });

  it('reports a failed batch and writes nothing', () => {
    const doc = seededDoc();
    let updates = 0;
    doc.ydoc.on('update', () => updates++);
    const result = doc.apply([{ op: 'remove_node', id: 'missing' }], { actor: ada });
    expect(result.ok).toBe(false);
    expect(updates).toBe(0);
  });

  it('writes only the fields that changed', () => {
    const doc = seededDoc();
    const keys: string[] = [];
    (doc.ydoc.getMap('nodes').get('n_103') as Y.Map<unknown>).observe((event) =>
      keys.push(...event.keysChanged),
    );
    mustApply(doc, [{ op: 'update_node', id: 'n_103', patch: { title: 'B2' } }], bot, T2);
    expect(keys.sort()).toEqual(['title', 'updatedAt', 'updatedBy']);
  });

  it('converges when two replicas edit different fields of one node concurrently', () => {
    const one = seededDoc();
    const two = BoardDoc.fromUpdate(one.encodeState());
    mustApply(one, [{ op: 'update_node', id: 'n_102', patch: { title: 'Renamed' } }], ada, T1);
    mustApply(two, [{ op: 'update_node', id: 'n_102', patch: { status: 'done' } }], bot, T2);
    sync(one, two);
    expect(one.toJSON()).toEqual(two.toJSON());
    expect(one.getNode('n_102')).toMatchObject({ title: 'Renamed', status: 'done' });
  });

  it('emits one normalized event per transaction, local and remote', () => {
    const one = seededDoc();
    const two = BoardDoc.fromUpdate(one.encodeState());
    const localEvents: DocEvent[] = [];
    const remoteEvents: DocEvent[] = [];
    one.observe((event) => localEvents.push(event));
    two.observe((event) => remoteEvents.push(event));

    mustApply(one, [
      { op: 'move_node', id: 'n_103', view: { x: 10, y: 10 } },
      { op: 'update_node', id: 'n_102', patch: { title: 'A2', body: 'new' } },
    ]);
    mustApply(one, [{ op: 'remove_node', id: 'n_103' }], bot);
    sync(one, two);

    expect(localEvents).toHaveLength(2);
    expect(localEvents[0]).toMatchObject({
      local: true,
      origin: { actorId: 'ada', source: 'ops' },
    });
    expect(localEvents[0]?.changes).toEqual([
      { kind: 'node_updated', id: 'n_102', title: 'A2', fields: ['body', 'title'] },
      { kind: 'node_moved', id: 'n_103', title: 'B' },
    ]);
    expect(localEvents[1]?.origin).toBe(one.origin('bot', 'ops'));
    expect(localEvents[1]?.changes).toEqual(
      expect.arrayContaining([
        { kind: 'node_removed', id: 'n_103', title: 'B' },
        { kind: 'edge_removed', id: 'e_104', title: 'A2 -> B' },
      ]),
    );

    expect(remoteEvents).toHaveLength(1);
    expect(remoteEvents[0]).toMatchObject({ local: false, origin: null });
    expect(remoteEvents[0]?.changes).toEqual(
      expect.arrayContaining([
        { kind: 'node_updated', id: 'n_102', title: 'A2', fields: ['body', 'title'] },
        { kind: 'node_removed', id: 'n_103', title: 'B' },
        { kind: 'edge_removed', id: 'e_104', title: 'A2 -> B' },
      ]),
    );
    expect(two.toJSON()).toEqual(one.toJSON());
  });

  it('interns transaction origins', () => {
    const doc = seededDoc();
    expect(doc.origin('ada', 'ui')).toBe(doc.origin('ada', 'ui'));
    expect(doc.origin('ada', 'ui')).not.toBe(doc.origin('ada', 'ops'));
  });

  it('undoes one actor batch without touching another actor', () => {
    const doc = seededDoc();
    const undoAda = doc.createUndoManager('ada');
    const events: DocEvent[] = [];
    doc.observe((event) => events.push(event));

    mustApply(doc, [
      { op: 'update_node', id: 'n_102', patch: { title: 'By Ada' } },
      { op: 'add_node', id: 'extra', node: { type: 'note', title: 'Extra' } },
    ]);
    mustApply(doc, [{ op: 'update_node', id: 'n_102', patch: { status: 'done' } }], bot, T2);

    undoAda.undo();
    const node = doc.getNode('n_102');
    expect(node).toMatchObject({ title: 'A', status: 'done' });
    expect(doc.getNode('extra')).toBeUndefined();
    expect(events.at(-1)?.origin).toBe(doc.origin('ada', 'undo'));
    expect(undoAda.undoStack).toHaveLength(0);
  });

  it('reconcile writes nothing when the document already matches', () => {
    const doc = seededDoc();
    let updates = 0;
    doc.ydoc.on('update', () => updates++);
    const applied = doc.reconcile(doc.toJSON(), doc.origin('system', 'file'));
    expect(updates).toBe(0);
    expect(applied).toMatchObject({ addedNodes: [], updatedNodes: [], removedNodes: [] });
  });

  it('reconcile makes the document equal to the target, bookkeeping included', () => {
    const doc = seededDoc();
    const target = structuredClone(doc.toJSON());
    const changed = target.nodes.n_102;
    if (!changed) throw new Error('fixture');
    changed.title = 'From disk';
    changed.updatedBy = 'someone';
    changed.updatedAt = '2025-05-05T00:00:00.000Z';
    delete target.nodes.n_103;
    delete target.edges.e_104;
    target.nodes.fresh = { ...changed, id: 'fresh', title: 'Fresh' };
    delete target.nodes.fresh.parent;

    const events: DocEvent[] = [];
    doc.observe((event) => events.push(event));
    const applied = doc.reconcile(target, doc.origin('system', 'file'));
    expect(doc.toJSON()).toEqual(target);
    expect(applied).toMatchObject({
      addedNodes: ['fresh'],
      updatedNodes: ['n_102'],
      removedNodes: ['n_103'],
      removedEdges: ['e_104'],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.origin).toEqual({ actorId: 'system', source: 'file' });
  });

  it('toJSON skips entries a misbehaving peer corrupted, and lists them', () => {
    const doc = seededDoc();
    const nodes = doc.ydoc.getMap('nodes');
    const edges = doc.ydoc.getMap('edges');
    doc.ydoc.transact(() => {
      nodes.set('junk', 'not a map');
      const half = new Y.Map<unknown>();
      half.set('id', 'half');
      half.set('type', 'note');
      nodes.set('half', half);
      const dangling = new Y.Map<unknown>();
      for (const [key, value] of Object.entries({
        id: 'e_bad',
        type: 'blocks',
        source: 'n_102',
        target: 'ghost',
        createdBy: 'x',
        createdAt: T0.toISOString(),
        updatedBy: 'x',
        updatedAt: T0.toISOString(),
      })) {
        dangling.set(key, value);
      }
      edges.set('e_bad', dangling);
    });

    const board = doc.toJSON();
    expect(Object.keys(board.nodes).sort()).toEqual(['n_101', 'n_102', 'n_103']);
    expect(Object.keys(board.edges)).toEqual(['e_104']);
    expect(doc.getEdge('e_bad')).toBeUndefined();
    const issues = doc.issues().join('\n');
    expect(issues).toContain('node "junk"');
    expect(issues).toContain('node "half"');
    expect(issues).toContain('edge "e_bad"');
    expect(doc.summary()).toMatchObject({ nodeCount: 3, edgeCount: 1 });
  });

  it('wraps an empty document and fills in once the first sync arrives', () => {
    const source = seededDoc();
    const ydoc = new Y.Doc();
    const doc = BoardDoc.fromYDoc(ydoc);
    expect(doc.ready).toBe(false);
    expect(doc.nodes()).toEqual([]);
    expect(doc.issues()[0]).toContain('missing');

    const events: DocEvent[] = [];
    doc.observe((event) => events.push(event));
    Y.applyUpdate(ydoc, source.encodeState());
    expect(doc.ready).toBe(true);
    expect(doc.meta.id).toBe('main');
    expect(doc.toJSON()).toEqual(source.toJSON());
    expect(events).toHaveLength(1);
    expect(events[0]?.metaChanged).toBe(true);
  });

  it('setMeta renames the board and records the actor', () => {
    const doc = seededDoc();
    expect(doc.setMeta({ name: 'Renamed', description: 'About' }, bot, { now: T2 })).toBe(true);
    expect(doc.meta).toMatchObject({
      name: 'Renamed',
      description: 'About',
      updatedAt: T2.toISOString(),
    });
    expect(doc.toJSON().actors.bot).toEqual(bot);
    expect(doc.setMeta({ name: 'Renamed' }, bot)).toBe(false);
    expect(doc.setMeta({ description: null }, bot)).toBe(true);
    expect(doc.meta.description).toBeUndefined();
  });
});
