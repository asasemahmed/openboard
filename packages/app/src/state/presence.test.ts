import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { AGENT, ME, sampleDoc } from '../test/fixtures.js';
import { PresenceStore, parsePeer, presenceState, selectionPayload } from './presence.js';
import { createSession } from './session.js';
import { createLocalTransport } from './transport.js';

afterEach(() => vi.useRealTimers());

describe('presence payloads', () => {
  it('builds the Presence shape with sorted ids and a timestamp', () => {
    const at = new Date('2026-11-12T10:00:00.000Z');
    expect(
      presenceState(ME, { x: 10.4, y: 20.6 }, selectionPayload(['b', 'a'], ['e2', 'e1'], at)),
    ).toEqual({
      actor: ME,
      cursor: { x: 10, y: 21 },
      selection: { nodeIds: ['a', 'b'], edgeIds: ['e1', 'e2'], at: '2026-11-12T10:00:00.000Z' },
    });
  });

  it('clears to empty arrays, never to a missing selection', () => {
    const state = presenceState(ME, null, selectionPayload([], []));
    expect(state.selection).toMatchObject({ nodeIds: [], edgeIds: [] });
    expect(state).not.toHaveProperty('cursor');
  });

  it('reads untrusted peer state defensively', () => {
    expect(parsePeer(1, null)).toBeNull();
    expect(parsePeer(1, { actor: { id: 5 } })).toBeNull();
    const peer = parsePeer(2, {
      actor: { id: 'a_x', name: 'Bo', kind: 'agent', color: 'red; background:url(x)' },
      cursor: { x: Number.NaN, y: 1 },
      selection: { nodeIds: ['n1', 3], edgeIds: ['e1'] },
    });
    expect(peer?.actor).toEqual({ id: 'a_x', name: 'Bo', kind: 'agent' });
    expect(peer?.cursor).toBeUndefined();
    expect(peer?.nodeIds).toEqual([]);
    expect(peer?.edgeIds).toEqual(['e1']);
  });
});

describe('PresenceStore', () => {
  it('publishes the local actor and selection on the awareness channel', () => {
    const awareness = new Awareness(new Y.Doc());
    const presence = new PresenceStore(awareness, ME);
    presence.setSelection(['n2', 'n1'], []);
    expect(awareness.getLocalState()).toMatchObject({
      actor: ME,
      selection: { nodeIds: ['n1', 'n2'], edgeIds: [] },
    });
    presence.setSelection([], []);
    expect(awareness.getLocalState()?.selection).toMatchObject({ nodeIds: [], edgeIds: [] });
  });

  it('throttles cursor updates and clears the cursor when the pointer leaves', () => {
    vi.useFakeTimers();
    const awareness = new Awareness(new Y.Doc());
    const presence = new PresenceStore(awareness, ME);
    const spy = vi.spyOn(awareness, 'setLocalState');
    presence.setCursor({ x: 1, y: 1 });
    presence.setCursor({ x: 2, y: 2 });
    presence.setCursor({ x: 3, y: 3 });
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    vi.advanceTimersByTime(60);
    expect(awareness.getLocalState()?.cursor).toEqual({ x: 3, y: 3 });
    presence.setCursor(null);
    expect(awareness.getLocalState()?.cursor).toBeUndefined();
  });

  it('lists other participants and who has which node selected', () => {
    const awareness = new Awareness(new Y.Doc());
    const presence = new PresenceStore(awareness, ME);
    const other = new Awareness(new Y.Doc());
    other.setLocalState({ actor: AGENT, selection: { nodeIds: ['risk1'], edgeIds: [], at: 'x' } });
    // Relay the other client's state the way the provider would.
    const states = other.getStates();
    awareness.states.set(other.clientID, states.get(other.clientID) as Record<string, unknown>);
    awareness.emit('change', [{ added: [other.clientID], updated: [], removed: [] }, 'remote']);
    expect(presence.participants.map((p) => p.actor.name)).toEqual(['planner']);
    expect(presence.peersOnNode('risk1')).toContain('planner');
    expect(presence.peersOnNode('task1')).toBe('');
  });
});

describe('session wiring', () => {
  it('mirrors every selection change into presence, including clearing it', () => {
    const session = createSession({
      boardId: 'test-board',
      actor: ME,
      api: { listBoards: vi.fn(), createBoard: vi.fn(), layout: vi.fn() },
      transport: (ydoc) => createLocalTransport(ydoc),
      doc: sampleDoc(),
    });
    const awareness = session.presence.awareness;
    session.store.select(['risk1'], ['e1']);
    expect(awareness.getLocalState()?.selection).toMatchObject({
      nodeIds: ['risk1'],
      edgeIds: ['e1'],
    });
    session.doc.apply([{ op: 'remove_node', id: 'risk1' }], { actor: AGENT });
    expect(awareness.getLocalState()?.selection).toMatchObject({ nodeIds: [], edgeIds: [] });
    session.store.select(['note1']);
    session.store.clearSelection();
    expect(awareness.getLocalState()?.selection).toMatchObject({ nodeIds: [], edgeIds: [] });
    session.destroy();
  });

  it('undoes only this actor’s changes', () => {
    const session = createSession({
      boardId: 'test-board',
      actor: ME,
      api: { listBoards: vi.fn(), createBoard: vi.fn(), layout: vi.fn() },
      transport: (ydoc) => createLocalTransport(ydoc),
      doc: sampleDoc(),
    });
    session.store.apply([{ op: 'update_node', id: 'note1', patch: { title: 'Mine' } }], ME);
    session.doc.apply([{ op: 'update_node', id: 'risk1', patch: { title: 'Theirs' } }], {
      actor: AGENT,
    });
    expect(session.undo.get().canUndo).toBe(true);
    session.undo.undo();
    expect(session.store.node('note1')?.title).toBe('Loose note');
    expect(session.store.node('risk1')?.title).toBe('Theirs');
    session.destroy();
  });
});
