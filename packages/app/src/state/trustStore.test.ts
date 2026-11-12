import { describe, expect, it } from 'vitest';
import { AGENT, ME, propose, sampleDoc } from '../test/fixtures.js';
import { classify } from './activity.js';
import { BoardStore } from './boardStore.js';

describe('BoardStore review state', () => {
  it('draws pending proposals as ghosts and lets the real node take over', () => {
    const doc = sampleDoc();
    const store = new BoardStore(doc);
    const proposal = propose(
      doc,
      [{ op: 'add_node', ref: 'x', node: { type: 'note', title: 'Proposed' } }],
      ['review'],
    );
    const id = proposal.items[0]?.op.op === 'add_node' ? (proposal.items[0].op.id as string) : '';
    expect(store.nodes.find((n) => n.id === id)?.data.ghost).toBe(true);
    expect(store.review().ghostOwner.get(id)).toBe(proposal.id);

    // Accepting lands the node under the same id before the proposal is updated.
    doc.apply(
      proposal.items.map((item) => item.op),
      { actor: AGENT },
    );
    expect(store.nodes.filter((n) => n.id === id).map((n) => n.data.ghost)).toEqual([false]);
    doc.putProposal({ ...proposal, status: 'accepted' }, doc.origin('system', 'ops'));
    expect(store.review().pending).toHaveLength(0);
    store.destroy();
  });

  it('keeps selectors stable until their collection changes', () => {
    const doc = sampleDoc();
    const store = new BoardStore(doc);
    const review = store.review();
    const comments = store.comments();
    doc.apply([{ op: 'update_node', id: 'note1', patch: { title: 'Moved on' } }], { actor: ME });
    expect(store.review()).toBe(review);
    expect(store.comments()).toBe(comments);
    doc.putComment(
      {
        id: 'c_1',
        thread: 'c_1',
        nodeId: 'note1',
        author: AGENT.id,
        body: 'Hello',
        createdAt: new Date().toISOString(),
      },
      doc.origin(AGENT.id, 'ops'),
    );
    expect(store.comments()).not.toBe(comments);
    expect(store.comments().openByNode.get('note1')).toBe(1);
    store.destroy();
  });

  it('highlights a card someone else commented on', () => {
    const doc = sampleDoc();
    let changes: ReturnType<typeof classify> = [];
    doc.observe((event) => {
      changes = classify(event, {
        me: ME.id,
        node: (id) => doc.getNode(id),
        edge: (id) => doc.getEdge(id),
        live: true,
        now: Date.now(),
      });
    });
    doc.putComment(
      {
        id: 'c_2',
        thread: 'c_2',
        nodeId: 'risk1',
        author: AGENT.id,
        body: 'Look here',
        createdAt: new Date().toISOString(),
      },
      doc.origin(AGENT.id, 'ops'),
    );
    expect(changes).toEqual([{ kind: 'node', id: 'risk1', verb: 'commented', actorId: AGENT.id }]);
  });
});
