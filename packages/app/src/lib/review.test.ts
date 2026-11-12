import type { Proposal } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { propose, sampleDoc } from '../test/fixtures.js';
import {
  affectedNodes,
  decisionOutcome,
  deriveReview,
  fieldChanges,
  futureOutlines,
  initialSelection,
  toggleItem,
  withFutureViews,
} from './review.js';

function lookup(doc: ReturnType<typeof sampleDoc>) {
  return { node: (id: string) => doc.getNode(id), edge: (id: string) => doc.getEdge(id) };
}

describe('deriveReview', () => {
  it('draws additions as ghosts and marks what would change or go', () => {
    const doc = sampleDoc();
    const proposal = propose(
      doc,
      [
        { op: 'add_node', ref: 'n', node: { type: 'task', title: 'New one', parent: 'inner' } },
        { op: 'add_edge', edge: { type: 'blocks', source: '$n', target: 'task1' } },
        { op: 'update_node', id: 'risk1', patch: { status: 'done', title: 'Fixed' } },
        { op: 'remove_node', id: 'note1' },
        { op: 'remove_edge', id: 'e1' },
      ],
      ['free', 'free', 'review', 'review', 'review'],
    );
    const review = deriveReview(doc.proposals(), lookup(doc));
    expect(review.pending.map((p) => p.id)).toEqual([proposal.id]);

    const ghost = review.ghostNodes[0];
    expect(ghost?.title).toBe('New one');
    expect(ghost?.parent).toBe('inner');
    expect(review.ghostEdges).toHaveLength(1);
    expect(review.ghostOwner.get(ghost?.id ?? '')).toBe(proposal.id);

    expect(review.nodeMarks.get('risk1')).toMatchObject({ kind: 'update' });
    expect(review.nodeMarks.get('risk1')?.fields).toEqual(
      expect.arrayContaining(['status', 'title']),
    );
    expect(review.nodeMarks.get('note1')).toMatchObject({ kind: 'remove' });
    // Removing note1 also removes e2, which touches it.
    expect(review.edgeMarks.get('e1')?.kind).toBe('remove');
    expect(review.edgeMarks.get('e2')?.kind).toBe('remove');

    const group = review.groups[0];
    expect(group?.ghostNodeIds).toEqual([ghost?.id]);
    expect(group?.touchedNodeIds).toEqual(expect.arrayContaining(['risk1', 'note1', 'task1']));
  });

  it('keeps nested ghost frames nested and lifts ghosts whose frame is gone', () => {
    const doc = sampleDoc();
    propose(
      doc,
      [
        { op: 'add_node', ref: 'f', node: { type: 'frame', title: 'New frame', parent: 'outer' } },
        { op: 'add_node', ref: 'c', node: { type: 'note', title: 'Inside', parent: '$f' } },
      ],
      ['free', 'free'],
    );
    let review = deriveReview(doc.proposals(), lookup(doc));
    const frame = review.ghostNodes.find((n) => n.title === 'New frame');
    const child = review.ghostNodes.find((n) => n.title === 'Inside');
    expect(frame?.parent).toBe('outer');
    expect(child?.parent).toBe(frame?.id);

    // Without the outer frame (removed meanwhile) the new frame is drawn at the top level.
    const without = {
      node: (id: string) => (id === 'outer' ? undefined : doc.getNode(id)),
      edge: (id: string) => doc.getEdge(id),
    };
    review = deriveReview(doc.proposals(), without);
    expect(review.ghostNodes.find((n) => n.title === 'New frame')?.parent).toBeUndefined();
  });

  it('marks cards whose proposed change became a conflict', () => {
    const doc = sampleDoc();
    const proposal = propose(
      doc,
      [{ op: 'update_node', id: 'task1', patch: { title: 'Theirs' } }],
      ['review'],
    );
    const conflicted: Proposal = {
      ...proposal,
      items: proposal.items.map((item) => ({
        ...item,
        status: 'conflict',
        conflict: '"Payment API" was changed by Ada after this was proposed',
      })),
      preview: { nodes: {}, edges: {}, updated: {}, removedNodes: [], removedEdges: [] },
    };
    doc.putProposal(conflicted, doc.origin('system', 'ops'));
    const review = deriveReview(doc.proposals(), lookup(doc));
    expect(review.nodeMarks.get('task1')).toMatchObject({
      kind: 'conflict',
      reason: expect.stringContaining('changed by Ada'),
    });
    expect(review.ghostNodes).toHaveLength(0);
  });

  it('orders pending proposals newest first, and leaves decided ones out of the canvas', () => {
    const doc = sampleDoc();
    const older = propose(doc, [{ op: 'remove_node', id: 'note1' }], ['review'], {
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const newer = propose(doc, [{ op: 'remove_node', id: 'risk1' }], ['review'], {
      now: new Date('2026-01-02T00:00:00Z'),
    });
    const decided = propose(doc, [{ op: 'remove_node', id: 'task1' }], ['review']);
    doc.putProposal({ ...decided, status: 'rejected' }, doc.origin('system', 'ops'));
    const review = deriveReview(doc.proposals(), lookup(doc));
    expect(review.pending.map((p) => p.id)).toEqual([newer.id, older.id]);
    expect(review.decided.map((p) => p.id)).toEqual([decided.id]);
    expect(review.nodeMarks.has('task1')).toBe(false);
  });
});

describe('future layout', () => {
  it('takes predicted views of existing nodes and turns them into outlines', () => {
    const doc = sampleDoc();
    const proposal = propose(
      doc,
      [{ op: 'add_node', node: { type: 'note', title: 'Wide', parent: 'inner' } }],
      ['review'],
    );
    doc.putProposal(
      {
        ...proposal,
        preview: {
          ...proposal.preview,
          views: {
            inner: { x: 40, y: 60, w: 400, h: 520 },
            risk1: { x: 1000, y: 400 },
            gone: { x: 0, y: 0 },
          },
        },
      },
      doc.origin('system', 'ops'),
    );
    const review = deriveReview(doc.proposals(), lookup(doc));
    expect([...review.futureViews.keys()].sort()).toEqual(['inner', 'risk1']);
    expect(review.groups[0]?.touchedNodeIds).toEqual(expect.arrayContaining(['inner', 'risk1']));

    const map = new Map([
      ['outer', { id: 'outer', x: 100, y: 100, w: 800, h: 600, frame: true }],
      ['inner', { id: 'inner', parent: 'outer', x: 40, y: 60, w: 400, h: 300, frame: true }],
      ['risk1', { id: 'risk1', x: 1000, y: 100, w: 264, h: 144, frame: false }],
    ]);
    const future = withFutureViews(map, review.futureViews);
    expect(future.get('inner')).toMatchObject({ x: 40, y: 60, w: 400, h: 520 });
    // A view without a size keeps the current one; the input map is untouched.
    expect(future.get('risk1')).toMatchObject({ y: 400, w: 264, h: 144 });
    expect(map.get('inner')?.h).toBe(300);

    const outlines = futureOutlines(map, review.futureViews);
    expect(outlines).toEqual([
      {
        id: 'inner',
        proposalId: proposal.id,
        frame: true,
        now: { x: 140, y: 160, w: 400, h: 300 },
        next: { x: 140, y: 160, w: 400, h: 520 },
      },
      {
        id: 'risk1',
        proposalId: proposal.id,
        frame: false,
        now: { x: 1000, y: 100, w: 264, h: 144 },
        next: { x: 1000, y: 400, w: 264, h: 144 },
      },
    ]);
  });
});

describe('fieldChanges', () => {
  it('shows each changed field before and after', () => {
    const doc = sampleDoc();
    const proposal = propose(
      doc,
      [{ op: 'update_node', id: 'risk1', patch: { status: 'done', tags: null, parent: 'outer' } }],
      ['review'],
    );
    const node = doc.getNode('risk1');
    if (!node) throw new Error('missing');
    const changes = fieldChanges(node, proposal, (id) => doc.getNode(id)?.title ?? id);
    expect(changes).toEqual([
      { field: 'status', before: 'in progress', after: 'done' },
      { field: 'tags', before: 'payments, p1, retry', after: 'cleared' },
      { field: 'parent', before: 'none', after: 'Release' },
    ]);
  });
});

describe('item selection', () => {
  const doc = sampleDoc();
  const proposal = propose(
    doc,
    [
      { op: 'add_node', ref: 'a', node: { type: 'task', title: 'A' } },
      { op: 'add_node', ref: 'b', node: { type: 'task', title: 'B' } },
      { op: 'add_edge', edge: { type: 'blocks', source: '$a', target: '$b' } },
      { op: 'remove_node', id: 'note1' },
    ],
    ['free', 'free', 'free', 'review'],
  );

  it('starts with every pending item', () => {
    expect([...initialSelection(proposal)]).toEqual([0, 1, 2, 3]);
  });

  it('unchecking an item unchecks what depends on it', () => {
    const next = toggleItem(proposal.items, initialSelection(proposal), 1, false);
    expect([...next].sort()).toEqual([0, 3]);
  });

  it('checking an item checks what it depends on', () => {
    const next = toggleItem(proposal.items, new Set([3]), 2, true);
    expect([...next].sort()).toEqual([0, 1, 2, 3]);
  });

  it('never selects a conflict', () => {
    const items = proposal.items.map((item) =>
      item.index === 0 ? { ...item, status: 'conflict' as const } : item,
    );
    const next = toggleItem(items, new Set(), 2, true);
    expect([...next].sort()).toEqual([1, 2]);
    expect([...toggleItem(items, new Set(), 0, true)]).toEqual([]);
  });

  it('points at the nodes an item is about', () => {
    const [addA, , edge, remove] = proposal.items;
    if (!addA || !edge || !remove) throw new Error('missing');
    const board = lookup(doc);
    expect(affectedNodes(addA, proposal, board)).toEqual([
      addA.op.op === 'add_node' ? addA.op.id : '',
    ]);
    expect(affectedNodes(edge, proposal, board)).toHaveLength(2);
    expect(affectedNodes(remove, proposal, board)).toEqual(['note1']);
  });

  it('says what a decision did', () => {
    const after: Proposal = {
      ...proposal,
      items: proposal.items.map((item) =>
        item.index === 3
          ? { ...item, status: 'conflict', conflict: 'note1 was removed after this was proposed' }
          : { ...item, status: 'accepted' },
      ),
    };
    const outcome = decisionOutcome(proposal, after);
    expect(outcome.accepted).toBe(3);
    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.text).toBe(
      'Accepted 3 items. 1 item could not be applied because the board changed.',
    );
  });
});
