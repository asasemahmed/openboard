import { type Actor, BoardDoc } from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { CLOSE_BOARD_NOT_FOUND } from './sync.js';
import { removeRoot, startTestServer, tempRoot, waitFor } from './testing.js';
import type { OpenBoardServer } from './types.js';

const ALICE: Actor = { id: 'alice', kind: 'human', name: 'Alice' };
const BOB: Actor = { id: 'bob', kind: 'human', name: 'Bob' };
const AGENT: Actor = { id: 'helper', kind: 'agent', name: 'Helper' };

let root: string;
let server: OpenBoardServer;
const providers: WebsocketProvider[] = [];

function connect(actor: Actor, boardId = 'plan') {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(
    `${server.url.replace('http', 'ws')}/sync`,
    boardId,
    ydoc,
    {
      // `ws` implements the browser WebSocket interface the provider needs.
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      params: { actorId: actor.id, actorName: actor.name, actorKind: actor.kind },
      // Same-process providers would otherwise sync with each other directly, bypassing the server.
      disableBc: true,
    },
  );
  providers.push(provider);
  const synced = new Promise<void>((resolve) => {
    if (provider.synced) resolve();
    else provider.once('sync', () => resolve());
  });
  return { ydoc, provider, synced, doc: BoardDoc.fromYDoc(ydoc) };
}

beforeEach(async () => {
  root = await tempRoot();
  server = await startTestServer(root);
  await server.api(AGENT).createBoard({ name: 'Plan' });
});

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await server.close();
  await removeRoot(root);
});

describe('sync', () => {
  it('sends the board to a client and attributes its edits to the connection actor', async () => {
    await server.api(AGENT).apply('plan', {
      ops: [{ op: 'add_node', node: { type: 'note', title: 'From the agent' } }],
    });
    const alice = connect(ALICE);
    await alice.synced;
    expect(alice.doc.ready).toBe(true);
    expect(alice.doc.nodes().map((n) => n.title)).toEqual(['From the agent']);

    const outcome = alice.doc.apply(
      [{ op: 'add_node', id: 'n_alice', node: { type: 'task', title: 'From Alice' } }],
      { actor: ALICE, source: 'ui' },
    );
    expect(outcome.ok).toBe(true);

    const agent = server.api(AGENT);
    await waitFor(async () => (await agent.getBoard('plan')).nodes.n_alice, {
      what: 'the server to see the edit',
    });
    const changes = await agent.changes('plan', { since: 0 });
    const added = changes.changes.find((c) => c.id === 'n_alice');
    expect(added).toMatchObject({ kind: 'node_added', actor: 'alice', title: 'From Alice' });
    expect(changes.text).toContain('Alice');
  });

  it('converges two clients', async () => {
    const alice = connect(ALICE);
    const bob = connect(BOB);
    await Promise.all([alice.synced, bob.synced]);
    alice.doc.apply([{ op: 'add_node', id: 'n_a', node: { type: 'note', title: 'A' } }], {
      actor: ALICE,
    });
    bob.doc.apply([{ op: 'add_node', id: 'n_b', node: { type: 'note', title: 'B' } }], {
      actor: BOB,
    });
    await waitFor(() => alice.doc.getNode('n_b') && bob.doc.getNode('n_a'), {
      what: 'both clients to converge',
    });
    alice.doc.apply([{ op: 'update_node', id: 'n_b', patch: { title: 'B by Alice' } }], {
      actor: ALICE,
    });
    await waitFor(() => bob.doc.getNode('n_b')?.title === 'B by Alice');
    expect(alice.doc.toJSON()).toEqual(bob.doc.toJSON());
    const board = await server.api(AGENT).getBoard('plan');
    expect(board.nodes.n_b?.title).toBe('B by Alice');
    expect(board.nodes.n_a?.createdBy).toBe('alice');
  });

  it('serves a human selection published over awareness, and drops it on disconnect', async () => {
    await server.api(AGENT).apply('plan', {
      ops: [
        { op: 'add_node', id: 'n_one', node: { type: 'note', title: 'One' } },
        { op: 'add_node', id: 'n_two', node: { type: 'note', title: 'Two' } },
      ],
    });
    const alice = connect(ALICE);
    await alice.synced;
    alice.provider.awareness.setLocalState({
      actor: ALICE,
      selection: { nodeIds: ['n_two'], edgeIds: [], at: new Date().toISOString() },
    });
    // An agent's presence is not a human selection.
    const bot = connect(AGENT);
    await bot.synced;
    bot.provider.awareness.setLocalState({
      actor: AGENT,
      selection: { nodeIds: ['n_one'], edgeIds: [], at: new Date(Date.now() + 1000).toISOString() },
    });

    const api = server.api(AGENT);
    const selection = await waitFor(
      async () => {
        const s = await api.selection('plan');
        return s.nodeIds.length > 0 ? s : null;
      },
      { what: 'the selection to arrive' },
    );
    expect(selection.by).toEqual(ALICE);
    expect(selection.nodeIds).toEqual(['n_two']);
    expect(selection.nodes.map((n) => n.title)).toEqual(['Two']);

    const read = await api.read('plan', { selection: true });
    expect(read.nodes.map((n) => n.id)).toEqual(['n_two']);

    alice.provider.destroy();
    await waitFor(async () => (await api.selection('plan')).by === null, {
      what: 'the selection to be dropped',
    });
    expect((await api.read('plan', { selection: true })).nodes).toEqual([]);
  });

  it('closes sockets for unknown boards without creating them', async () => {
    const url = `${server.url.replace('http', 'ws')}/sync/missing`;
    const ws = new WebSocket(url);
    const closed = await new Promise<{ code: number; reason: string }>((resolve) =>
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    expect(closed.code).toBe(CLOSE_BOARD_NOT_FOUND);
    expect(closed.reason).toBe('board not found');
    expect((await server.api(AGENT).listBoards()).map((b) => b.id)).toEqual(['plan']);
  });

  it('refuses upgrades with a bad origin, a bad host, or an invalid board id', async () => {
    const status = (url: string, headers: Record<string, string> = {}) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(url, { headers });
        ws.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode ?? 0);
          ws.terminate();
        });
        ws.on('open', () => {
          resolve(101);
          ws.close();
        });
        ws.on('error', () => {});
      });
    const base = `${server.url.replace('http', 'ws')}/sync`;
    expect(await status(`${base}/plan`, { origin: 'https://attacker.example' })).toBe(403);
    expect(await status(`${base}/plan`, { host: 'attacker.example' })).toBe(403);
    expect(await status(`${base}/plan`, { origin: 'http://localhost:5173' })).toBe(101);
    expect(await status(`${base}/bad%20id`)).toBe(400);
    expect(await status(`${base}/plan?actorKind=robot`)).toBe(400);
  });

  it('survives malformed frames', async () => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/sync/plan`);
    await new Promise((resolve) => ws.on('open', resolve));
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    ws.send(Buffer.from([0, 2, 250, 250, 250, 250, 250]));
    expect(await closed).toBe(1007);
    const good = connect(ALICE);
    await good.synced;
    expect(good.doc.ready).toBe(true);
  });
});
