import { BoardDoc, type DocEvent } from '@openboard/core';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { offscreenGroups } from '../lib/offscreen.js';
import { AGENT, ME, sampleDoc } from '../test/fixtures.js';
import {
  type ActivityState,
  ActivityStore,
  type Clock,
  classify,
  dismissRemoval,
  EMPTY_ACTIVITY,
  expire,
  forget,
  HIGHLIGHT_MS,
  nextExpiry,
  REMOVAL_MERGE_MS,
  REMOVAL_MS,
  type RemoteChange,
  receive,
  removalMessage,
} from './activity.js';

const PEER = { id: 'a_peer000001', kind: 'human' as const, name: 'Grace' };

function record(doc: BoardDoc): DocEvent[] {
  const events: DocEvent[] = [];
  doc.observe((event) => events.push(event));
  return events;
}

function ctxFor(doc: BoardDoc, now = Date.now()) {
  return {
    me: ME.id,
    node: (id: string) => doc.getNode(id),
    edge: (id: string) => doc.getEdge(id),
    live: true,
    now,
  };
}

/** A server document and a browser replica that receives its updates through Yjs. */
function replicaPair() {
  const server = sampleDoc();
  const browser = BoardDoc.fromYDoc(new Y.Doc());
  Y.applyUpdate(browser.ydoc, Y.encodeStateAsUpdate(server.ydoc));
  server.ydoc.on('update', (update: Uint8Array) => Y.applyUpdate(browser.ydoc, update));
  return { server, browser };
}

const added = (id: string, actorId: string | null = AGENT.id): RemoteChange => ({
  kind: 'node',
  id,
  verb: 'added',
  actorId,
});
const removed = (id: string, actorId: string | null, title?: string): RemoteChange => ({
  kind: 'node',
  id,
  verb: 'removed',
  actorId,
  ...(title ? { title } : {}),
});

describe('classify', () => {
  it('keeps semantic changes by others and attributes them', () => {
    const doc = sampleDoc();
    const events = record(doc);
    doc.apply(
      [
        { op: 'add_node', id: 'new1', node: { type: 'task', title: 'Write tests' } },
        { op: 'update_node', id: 'task1', patch: { status: 'blocked' } },
      ],
      { actor: AGENT },
    );
    const changes = classify(events[0] as DocEvent, ctxFor(doc));
    expect(changes).toEqual([
      { kind: 'node', id: 'new1', verb: 'added', actorId: AGENT.id },
      { kind: 'node', id: 'task1', verb: 'updated', actorId: AGENT.id },
    ]);
  });

  it('ignores my own changes', () => {
    const doc = sampleDoc();
    const events = record(doc);
    doc.apply([{ op: 'update_node', id: 'task1', patch: { title: 'Mine' } }], {
      actor: ME,
      source: 'ui',
    });
    expect(classify(events[0] as DocEvent, ctxFor(doc))).toEqual([]);
  });

  it('ignores pure moves and the layout engine', () => {
    const doc = sampleDoc();
    const events = record(doc);
    doc.apply([{ op: 'move_node', id: 'note1', view: { x: 400, y: 400 } }], { actor: AGENT });
    doc.apply([{ op: 'update_node', id: 'note1', patch: { title: 'Laid out' } }], {
      actor: AGENT,
      source: 'layout',
    });
    doc.apply([{ op: 'update_node', id: 'note1', patch: { title: 'From disk' } }], {
      actor: AGENT,
      source: 'file',
    });
    expect(events).toHaveLength(3);
    for (const event of events) expect(classify(event, ctxFor(doc))).toEqual([]);
  });

  it('attributes changes from the server through createdBy and updatedBy', () => {
    const { server, browser } = replicaPair();
    const events = record(browser);
    server.apply([{ op: 'add_node', id: 'new1', node: { type: 'note', title: 'Hi' } }], {
      actor: AGENT,
    });
    server.apply([{ op: 'update_node', id: 'task1', patch: { title: 'Renamed' } }], {
      actor: PEER,
    });
    server.apply([{ op: 'move_node', id: 'task1', view: { x: 80, y: 80 } }], { actor: PEER });
    expect(events.map((e) => e.origin)).toEqual([null, null, null]);
    expect(events.map((e) => classify(e, ctxFor(browser)))).toEqual([
      [{ kind: 'node', id: 'new1', verb: 'added', actorId: AGENT.id }],
      [{ kind: 'node', id: 'task1', verb: 'updated', actorId: PEER.id }],
      [],
    ]);
  });

  it('leaves removals from the server unattributed, with the old title', () => {
    const { server, browser } = replicaPair();
    const events = record(browser);
    server.apply([{ op: 'remove_node', id: 'note1' }], { actor: AGENT });
    const changes = classify(events[0] as DocEvent, ctxFor(browser));
    expect(changes).toContainEqual({
      kind: 'node',
      id: 'note1',
      verb: 'removed',
      actorId: null,
      title: 'Loose note',
    });
  });

  it('ignores history arriving late, and everything before the first sync', () => {
    const { server, browser } = replicaPair();
    const events = record(browser);
    server.apply([{ op: 'add_node', id: 'new1', node: { type: 'note', title: 'Old' } }], {
      actor: AGENT,
    });
    const event = events[0] as DocEvent;
    const later = Date.now() + 10 * 60_000;
    expect(classify(event, ctxFor(browser, later))).toEqual([]);
    expect(classify(event, { ...ctxFor(browser), live: false })).toEqual([]);
  });
});

describe('highlight lifecycle', () => {
  it('highlights for HIGHLIGHT_MS, then expires', () => {
    let state = receive(EMPTY_ACTIVITY, [added('n1')], ME.id, 1000);
    expect(state.highlights.get('node:n1')).toMatchObject({ verb: 'added', actorId: AGENT.id });
    expect(nextExpiry(state)).toBe(1000 + HIGHLIGHT_MS);
    expect(expire(state, 1000 + HIGHLIGHT_MS - 1)).toBe(state);
    state = expire(state, 1000 + HIGHLIGHT_MS);
    expect(state.highlights.size).toBe(0);
    expect(nextExpiry(state)).toBeNull();
  });

  it('restarts on a further change and keeps "added" for a fresh node', () => {
    let state = receive(EMPTY_ACTIVITY, [added('n1')], ME.id, 0);
    state = receive(state, [{ ...added('n1'), verb: 'updated' }], ME.id, 5000);
    expect(state.highlights.get('node:n1')).toMatchObject({
      verb: 'added',
      until: 5000 + HIGHLIGHT_MS,
    });
    state = receive(state, [{ ...added('n2'), verb: 'updated' }], ME.id, 5000);
    expect(state.highlights.get('node:n2')?.verb).toBe('updated');
  });

  it('never highlights my own or unattributed changes', () => {
    const state = receive(EMPTY_ACTIVITY, [added('n1', ME.id), added('n2', null)], ME.id, 0);
    expect(state).toBe(EMPTY_ACTIVITY);
  });

  it('drops the highlight of something that was removed', () => {
    let state = receive(EMPTY_ACTIVITY, [added('n1')], ME.id, 0);
    state = forget(state, [{ kind: 'node', id: 'n1' }]);
    expect(state.highlights.size).toBe(0);
    state = receive(EMPTY_ACTIVITY, [added('n1')], ME.id, 0);
    state = receive(state, [removed('n1', AGENT.id)], ME.id, 10);
    expect(state.highlights.size).toBe(0);
  });
});

describe('removal notices', () => {
  it('batches per actor and merges a quick follow-up', () => {
    let state = receive(
      EMPTY_ACTIVITY,
      [removed('a', AGENT.id, 'A'), removed('b', AGENT.id, 'B'), removed('c', PEER.id, 'C')],
      ME.id,
      0,
    );
    expect(state.removals.map((r) => [r.actorId, r.nodes])).toEqual([
      [AGENT.id, 2],
      [PEER.id, 1],
    ]);
    state = receive(state, [removed('d', AGENT.id)], ME.id, REMOVAL_MERGE_MS);
    expect(state.removals).toHaveLength(2);
    expect(state.removals[0]).toMatchObject({ nodes: 3, until: REMOVAL_MERGE_MS + REMOVAL_MS });
    state = receive(state, [removed('e', AGENT.id)], ME.id, REMOVAL_MERGE_MS * 2 + 1);
    expect(state.removals).toHaveLength(3);
  });

  it('ignores my own removals, expires and can be dismissed', () => {
    let state = receive(EMPTY_ACTIVITY, [removed('a', ME.id)], ME.id, 0);
    expect(state.removals).toHaveLength(0);
    state = receive(state, [removed('a', AGENT.id)], ME.id, 0);
    const id = state.removals[0]?.id ?? -1;
    expect(dismissRemoval(state, id).removals).toHaveLength(0);
    expect(expire(state, REMOVAL_MS).removals).toHaveLength(0);
  });

  it('words notices for one node, many nodes, connections and unknown actors', () => {
    const notice = (nodes: number, edges: number, titles: string[] = []) => ({
      id: 1,
      actorId: null,
      nodes,
      edges,
      titles,
      at: 0,
      until: 1,
    });
    expect(removalMessage(notice(1, 2, ['Retry logic']), 'Demo agent')).toBe(
      'Demo agent removed “Retry logic”',
    );
    expect(removalMessage(notice(2, 0), 'Demo agent')).toBe('Demo agent removed 2 nodes');
    expect(removalMessage(notice(0, 1), 'Grace')).toBe('Grace removed 1 connection');
    expect(removalMessage(notice(3, 0), null)).toBe('3 nodes were removed');
    expect(removalMessage(notice(1, 0, ['X']), null)).toBe('“X” was removed');
  });
});

describe('offscreenGroups', () => {
  const view = { x: 0, y: 0, w: 1000, h: 800 };
  const at = (x: number, y: number) => ({ rect: { x, y, w: 100, h: 60 }, nodeIds: [] as string[] });

  it('batches per actor and counts only what is out of view', () => {
    let state: ActivityState = receive(
      EMPTY_ACTIVITY,
      [added('in'), added('below1'), added('below2'), added('peer', PEER.id)],
      ME.id,
      0,
    );
    state = receive(state, [], ME.id, 0);
    const places: Record<string, ReturnType<typeof at>> = {
      in: at(100, 100),
      below1: { ...at(300, 1200), nodeIds: ['below1'] },
      below2: { ...at(500, 1400), nodeIds: ['below2'] },
      peer: { ...at(-900, 300), nodeIds: ['peer'] },
    };
    const groups = offscreenGroups(state.highlights.values(), (h) => places[h.id], view);
    expect(groups).toEqual([
      { actorId: AGENT.id, count: 2, side: 'bottom', nodeIds: ['below1', 'below2'] },
      { actorId: PEER.id, count: 1, side: 'left', nodeIds: ['peer'] },
    ]);
  });
});

describe('ActivityStore', () => {
  function fakeClock() {
    let now = 0;
    let timers: Array<{ at: number; fn: () => void; id: number }> = [];
    let nextId = 1;
    const clock: Clock = {
      now: () => now,
      setTimeout: (fn, ms) => {
        const id = nextId++;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimeout: (id) => {
        timers = timers.filter((t) => t.id !== id);
      },
    };
    const advance = async (ms: number) => {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
        await Promise.resolve();
      }
      now = end;
      await Promise.resolve();
    };
    return { clock, advance };
  }

  it('highlights, reports bursts, expires, and names who removed what', async () => {
    const { server, browser } = replicaPair();
    const { clock, advance } = fakeClock();
    const resolveRemovals = vi.fn(async () => new Map([['node:note1', AGENT.id]]));
    const activity = new ActivityStore({
      me: () => ME.id,
      node: (id) => browser.getNode(id),
      edge: (id) => browser.getEdge(id),
      live: () => true,
      clock,
      resolveRemovals,
    });
    browser.observe((event) => activity.onDocEvent(event));
    const bursts: string[][] = [];
    activity.onBurst((keys) => bursts.push([...keys]));

    server.apply([{ op: 'add_node', id: 'new1', node: { type: 'note', title: 'Hi' } }], {
      actor: AGENT,
    });
    server.apply([{ op: 'update_node', id: 'task1', patch: { title: 'Renamed' } }], {
      actor: AGENT,
    });
    expect(activity.highlightFor('node', 'new1')?.verb).toBe('added');
    expect(bursts).toEqual([]);
    await advance(500);
    expect(bursts).toEqual([['node:new1', 'node:task1']]);

    server.apply([{ op: 'remove_node', id: 'note1' }], { actor: AGENT });
    expect(activity.get().removals).toHaveLength(0);
    await advance(300);
    expect(resolveRemovals).toHaveBeenCalledTimes(1);
    expect(activity.get().removals[0]).toMatchObject({ actorId: AGENT.id, nodes: 1 });

    await advance(Math.max(HIGHLIGHT_MS, REMOVAL_MS));
    expect(activity.get().highlights.size).toBe(0);
    expect(activity.get().removals).toHaveLength(0);
    activity.destroy();
  });
});
