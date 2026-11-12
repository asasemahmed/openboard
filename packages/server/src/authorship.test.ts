import { type Actor, BoardDoc, type GrantAccessResult, type Role } from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { lineageOf, removeRoot, sleep, startTestServer, tempRoot, waitFor } from './testing.js';
import type { OpenBoardServer } from './types.js';

const PUBLIC = 'https://board.example.com';
const PUBLIC_HOST = 'board.example.com';
const OWNER: Actor = { id: 'owner', kind: 'human', name: 'Owner' };

let root: string;
let server: OpenBoardServer;
let lineage: string;
let now: number;
const providers: WebsocketProvider[] = [];

beforeEach(async () => {
  root = await tempRoot();
  now = Date.parse('2026-11-12T10:00:00.000Z');
  server = await startTestServer(root, { shared: true, publicUrl: PUBLIC, clock: () => now });
  await server.api(OWNER).createBoard({ name: 'Plan' });
  lineage = await lineageOf(server, 'plan');
});

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await server.close();
  await removeRoot(root);
});

const grant = (role: Role, kind: 'human' | 'agent' = 'human', label = `${role} ${kind}`) =>
  server.api(OWNER).grantAccess({ label, role, kind });

const syncBase = () => `${server.url.replace('http', 'ws')}/sync`;

/** `ws` with fixed upgrade headers, in the shape `WebsocketProvider` constructs. */
function withHeaders(headers: Record<string, string>): typeof globalThis.WebSocket {
  class HeaderSocket extends WebSocket {
    constructor(address: string, protocols?: string | string[]) {
      super(address, protocols, { headers });
    }
  }
  return HeaderSocket as unknown as typeof globalThis.WebSocket;
}

/** A real y-websocket client of board "plan", coming in from the public host. */
function client(headers: Record<string, string>, params: Record<string, string> = {}) {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(syncBase(), 'plan', ydoc, {
    WebSocketPolyfill: withHeaders({ host: PUBLIC_HOST, ...headers }),
    params: { lineage, ...params },
    disableBc: true,
  });
  providers.push(provider);
  const synced = new Promise<void>((resolve) => {
    if (provider.synced) resolve();
    else provider.once('sync', () => resolve());
  });
  return { ydoc, provider, synced, doc: BoardDoc.fromYDoc(ydoc) };
}

const bearer = (access: GrantAccessResult) => ({ authorization: `Bearer ${access.token}` });

describe('shared sync: authorship', () => {
  async function editorClient() {
    const access = await grant('editor');
    const c = client(bearer(access));
    await c.synced;
    const actor: Actor = { id: access.grant.actorId, kind: 'human', name: access.grant.label };
    return { ...c, actor, id: access.grant.actorId };
  }

  it('corrects a forged author on new nodes, edges and comments', async () => {
    const editor = await editorClient();
    const forger: Actor = { id: 'owner', kind: 'human', name: 'Owner' };
    editor.doc.apply(
      [
        { op: 'add_node', id: 'n_a', node: { type: 'note', title: 'A' } },
        { op: 'add_node', id: 'n_b', node: { type: 'note', title: 'B' } },
        { op: 'add_edge', id: 'e_ab', edge: { type: 'relates_to', source: 'n_a', target: 'n_b' } },
      ],
      { actor: forger, source: 'ui' },
    );
    editor.doc.putComment(
      {
        id: 'c_f',
        thread: 'c_f',
        author: 'owner',
        body: 'I approve',
        createdAt: new Date(now).toISOString(),
      },
      editor.doc.origin('owner', 'ui'),
    );
    const owner = server.api(OWNER);
    const board = await waitFor(
      async () => {
        const b = await owner.getBoard('plan');
        return b.nodes.n_a?.createdBy === editor.id && b.comments?.c_f?.author === editor.id
          ? b
          : null;
      },
      { what: 'the correction' },
    );
    expect(board.nodes.n_b).toMatchObject({ createdBy: editor.id, updatedBy: editor.id });
    expect(board.edges.e_ab).toMatchObject({ createdBy: editor.id, updatedBy: editor.id });
    expect(board.actors[editor.id]?.kind).toBe('human');
    // The forging client is corrected too, and history holds one batch by the editor.
    await waitFor(() => editor.doc.getNode('n_a')?.createdBy === editor.id, {
      what: 'the client to follow',
    });
    const history = await owner.history('plan', { includeMoves: true });
    expect(history.batches.filter((b) => b.actor === editor.id)).toHaveLength(1);
    expect(history.batches.some((b) => b.actor === 'owner')).toBe(false);
  });

  it('keeps createdBy and corrects updatedBy on an existing node', async () => {
    await server.api(OWNER).apply('plan', {
      ops: [{ op: 'add_node', id: 'n_o', node: { type: 'note', title: 'Owner note' } }],
    });
    const editor = await editorClient();
    await waitFor(() => editor.doc.getNode('n_o'), { what: 'the node to arrive' });
    editor.doc.apply([{ op: 'update_node', id: 'n_o', patch: { title: 'Edited' } }], {
      actor: { id: 'someone', kind: 'human', name: 'Someone' },
      source: 'ui',
    });
    const node = await waitFor(
      async () => {
        const n = (await server.api(OWNER).getBoard('plan')).nodes.n_o;
        return n?.title === 'Edited' && n.updatedBy === editor.id ? n : null;
      },
      { what: 'the correction' },
    );
    expect(node.createdBy).toBe('owner');
    expect((await server.api(OWNER).getBoard('plan')).actors.someone).toBeUndefined();
  });

  it('reverts a forged answer to a question, without telling the asker', async () => {
    const agent: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };
    const ask = await server
      .api(agent)
      .ask('plan', { question: 'Ship it?', options: ['yes', 'no'] });
    const editor = await editorClient();
    await waitFor(() => editor.doc.getAsk(ask.id), { what: 'the question to arrive' });
    editor.doc.putAsk(
      {
        ...ask,
        status: 'answered',
        answer: { by: 'owner', at: new Date(now).toISOString(), option: 'yes' },
      },
      editor.doc.origin('owner', 'ui'),
    );
    await sleep(100);
    expect((await server.api(agent).askResult('plan', ask.id)).status).toBe('open');
    await waitFor(() => editor.doc.getAsk(ask.id)?.status === 'open', {
      what: 'the client to be put back',
    });
    expect((await server.api(agent).inbox('plan', { since: 0 })).items).toEqual([]);
    // A forged proposal is removed.
    editor.doc.putProposal(
      {
        id: 'p_forged',
        author: 'bot',
        createdAt: new Date(now).toISOString(),
        status: 'accepted',
        items: [],
        preview: { nodes: {}, edges: {}, updated: {}, removedNodes: [], removedEdges: [] },
      },
      editor.doc.origin('owner', 'ui'),
    );
    await sleep(100);
    expect((await server.api(OWNER).proposals('plan', { status: 'all' })).proposals).toEqual([]);
  });

  it('leaves honest editing alone: no corrections, no extra batches, no loops', async () => {
    const editor = await editorClient();
    let updates = 0;
    editor.ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === editor.provider) updates++;
    });
    for (const title of ['One', 'Two', 'Three']) {
      editor.doc.apply([{ op: 'add_node', node: { type: 'note', title } }], {
        actor: editor.actor,
        source: 'ui',
      });
    }
    await waitFor(
      async () => Object.keys((await server.api(OWNER).getBoard('plan')).nodes).length === 3,
      {
        what: 'the edits',
      },
    );
    await sleep(150);
    expect(updates).toBe(0);
    const history = await server.api(OWNER).history('plan', { includeMoves: true });
    expect(history.batches).toHaveLength(1);
    expect(history.batches[0]).toMatchObject({
      actor: editor.id,
      source: 'ui',
      summary: 'Added 3 nodes',
    });
  });
});

describe('local mode', () => {
  it('does not correct authorship', async () => {
    const localRoot = await tempRoot();
    const local = await startTestServer(localRoot);
    try {
      await local.api(OWNER).createBoard({ name: 'Plan' });
      const localLineage = await lineageOf(local, 'plan');
      const ydoc = new Y.Doc();
      const provider = new WebsocketProvider(
        `${local.url.replace('http', 'ws')}/sync`,
        'plan',
        ydoc,
        {
          WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
          params: { lineage: localLineage, actorId: 'ada', actorName: 'Ada', actorKind: 'human' },
          disableBc: true,
        },
      );
      providers.push(provider);
      await waitFor(() => provider.synced, { what: 'sync' });
      BoardDoc.fromYDoc(ydoc).apply(
        [{ op: 'add_node', id: 'n_x', node: { type: 'note', title: 'X' } }],
        {
          actor: { id: 'bob', kind: 'human', name: 'Bob' },
          source: 'ui',
        },
      );
      const node = await waitFor(async () => (await local.api(OWNER).getBoard('plan')).nodes.n_x, {
        what: 'the edit',
      });
      await sleep(100);
      expect(node.createdBy).toBe('bob');
    } finally {
      await local.close();
      await removeRoot(localRoot);
    }
  });
});
