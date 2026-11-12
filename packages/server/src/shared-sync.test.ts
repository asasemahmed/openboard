import { type Actor, BoardDoc, type GrantAccessResult, type Role } from '@openboard/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { CLOSE_ACCESS_REVOKED, MAX_SOCKETS_PER_GRANT } from './sync.js';
import {
  lineageOf,
  rawRequest,
  removeRoot,
  sleep,
  startTestServer,
  tempRoot,
  waitFor,
} from './testing.js';
import type { OpenBoardServer } from './types.js';

const PUBLIC = 'https://board.example.com';
const PUBLIC_HOST = 'board.example.com';
const OWNER: Actor = { id: 'owner', kind: 'human', name: 'Owner' };

let root: string;
let server: OpenBoardServer;
let lineage: string;
let now: number;
const providers: WebsocketProvider[] = [];
const sockets: WebSocket[] = [];

beforeEach(async () => {
  root = await tempRoot();
  now = Date.parse('2026-11-12T10:00:00.000Z');
  server = await startTestServer(root, { shared: true, publicUrl: PUBLIC, clock: () => now });
  await server.api(OWNER).createBoard({ name: 'Plan' });
  lineage = await lineageOf(server, 'plan');
});

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  for (const ws of sockets.splice(0)) ws.terminate();
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

/** The HTTP status of an upgrade attempt (101 when it opened). */
function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { host: PUBLIC_HOST, ...headers } });
    sockets.push(ws);
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('open', () => resolve(101));
    ws.on('error', () => {});
  });
}

/** An open raw socket and the messages it receives. */
async function rawSocket(headers: Record<string, string>, query = '') {
  const ws = new WebSocket(`${syncBase()}/plan?lineage=${lineage}${query}`, {
    headers: { host: PUBLIC_HOST, ...headers },
  });
  sockets.push(ws);
  const messages: Uint8Array[] = [];
  ws.on('message', (data: Buffer) => messages.push(new Uint8Array(data)));
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return { ws, messages, closed };
}

function updateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

function awarenessMessage(
  entries: Array<{ id: number; clock: number; state: unknown }>,
): Uint8Array {
  const inner = encoding.createEncoder();
  encoding.writeVarUint(inner, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(inner, entry.id);
    encoding.writeVarUint(inner, entry.clock);
    encoding.writeVarString(inner, JSON.stringify(entry.state));
  }
  const outer = encoding.createEncoder();
  encoding.writeVarUint(outer, 1);
  encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner));
  return encoding.toUint8Array(outer);
}

describe('shared sync: read-only roles', () => {
  it("never lets a viewer's edit reach the server or other clients, but sends it everyone else's", async () => {
    const editorAccess = await grant('editor');
    const viewerAccess = await grant('viewer');
    const editor = client(bearer(editorAccess));
    const viewer = client(bearer(viewerAccess));
    await Promise.all([editor.synced, viewer.synced]);

    const viewerActor: Actor = { id: viewerAccess.grant.actorId, kind: 'human', name: 'V' };
    expect(
      viewer.doc.apply(
        [{ op: 'add_node', id: 'n_viewer', node: { type: 'note', title: 'Sneaky' } }],
        {
          actor: viewerActor,
        },
      ).ok,
    ).toBe(true);
    await sleep(100);
    const editorActor: Actor = { id: editorAccess.grant.actorId, kind: 'human', name: 'E' };
    editor.doc.apply([{ op: 'add_node', id: 'n_editor', node: { type: 'note', title: 'Real' } }], {
      actor: editorActor,
    });
    await waitFor(() => viewer.doc.getNode('n_editor'), { what: 'the viewer to receive the edit' });
    await sleep(100);

    const board = await server.api(OWNER).getBoard('plan');
    expect(Object.keys(board.nodes)).toEqual(['n_editor']);
    expect(board.nodes.n_editor?.createdBy).toBe(editorAccess.grant.actorId);
    expect(editor.doc.getNode('n_viewer')).toBeUndefined();

    // Presence still works for the viewer.
    viewer.provider.awareness.setLocalState({ actor: viewerActor, cursor: { x: 1, y: 2 } });
    await waitFor(
      () =>
        [...editor.provider.awareness.getStates().values()].find(
          (s) => (s as { actor?: Actor }).actor?.id === viewerAccess.grant.actorId,
        ),
      { what: "the viewer's presence" },
    );
  });

  it('tells a read-only client once, with a y-protocols permission-denied message', async () => {
    const viewer = await grant('viewer');
    const { ws, messages } = await rawSocket(bearer(viewer));
    const scratch = new Y.Doc();
    scratch.getMap('nodes').set('x', 1);
    ws.send(updateMessage(Y.encodeStateAsUpdate(scratch)));
    ws.send(updateMessage(Y.encodeStateAsUpdate(scratch)));
    await waitFor(() => messages.some((m) => m[0] === 2), { what: 'the denial' });
    await sleep(100);
    const denials = messages.filter((m) => m[0] === 2);
    expect(denials).toHaveLength(1);
    const decoder = decoding.createDecoder(denials[0] as Uint8Array);
    expect(decoding.readVarUint(decoder)).toBe(2);
    expect(decoding.readVarUint(decoder)).toBe(0);
    expect(decoding.readVarString(decoder)).toMatch(/^read-only: your access \(viewer\)/);
    expect((await server.api(OWNER).getBoard('plan')).nodes).toEqual({});
  });

  it('keeps commenters and agents read-only over sync; a comment goes through HTTP to everyone', async () => {
    const commenterAccess = await grant('commenter');
    const agentAccess = await grant('editor', 'agent');
    const commenter = client(bearer(commenterAccess));
    const agent = client(bearer(agentAccess));
    const owner = client({ host: new URL(server.url).host });
    await Promise.all([commenter.synced, agent.synced, owner.synced]);
    const actor: Actor = { id: 'x', kind: 'human', name: 'X' };
    commenter.doc.apply([{ op: 'add_node', id: 'n_c', node: { type: 'note', title: 'C' } }], {
      actor,
    });
    agent.doc.apply([{ op: 'add_node', id: 'n_a', node: { type: 'note', title: 'A' } }], { actor });
    // The owner at this machine writes through sync as before.
    owner.doc.apply([{ op: 'add_node', id: 'n_o', node: { type: 'note', title: 'O' } }], { actor });
    await waitFor(async () => (await server.api(OWNER).getBoard('plan')).nodes.n_o, {
      what: "the owner's edit",
    });

    const res = await rawRequest(server.url, {
      method: 'POST',
      path: '/api/boards/plan/comments',
      headers: { host: PUBLIC_HOST, ...bearer(commenterAccess) },
      body: JSON.stringify({ body: 'Looks good' }),
    });
    expect(res.status).toBe(201);
    await waitFor(
      () => owner.doc.comments().length === 1 && commenter.doc.comments().length === 1,
      {
        what: 'the comment on every client',
      },
    );
    expect(owner.doc.comments()[0]?.author).toBe(commenterAccess.grant.actorId);
    await sleep(50);
    const nodes = Object.keys((await server.api(OWNER).getBoard('plan')).nodes);
    expect(nodes).toEqual(['n_o']);
  });
});

describe('shared sync: credentials', () => {
  it('refuses an upgrade without valid credentials, and a token in the URL', async () => {
    const viewer = await grant('viewer');
    const url = `${syncBase()}/plan?lineage=${lineage}`;
    expect(await upgradeStatus(url)).toBe(401);
    expect(await upgradeStatus(url, { authorization: 'Bearer ob_nope' })).toBe(401);
    expect(await upgradeStatus(`${url}&token=${viewer.token}`)).toBe(400);
    expect(await upgradeStatus(url, bearer(viewer))).toBe(101);
    expect(
      await upgradeStatus(url, { 'x-forwarded-for': '1.2.3.4', host: new URL(server.url).host }),
    ).toBe(401);
    // The owner at this machine needs nothing, as before.
    expect(await upgradeStatus(url, { host: new URL(server.url).host })).toBe(101);
  });

  it('accepts a ticket once, within a minute', async () => {
    const editor = await grant('editor');
    const ticket = async () =>
      (
        await rawRequest(server.url, {
          method: 'POST',
          path: '/api/auth/ticket',
          headers: { host: PUBLIC_HOST, ...bearer(editor) },
        })
      ).json.ticket as string;
    const url = (t: string) => `${syncBase()}/plan?lineage=${lineage}&ticket=${t}`;
    const first = await ticket();
    expect(await upgradeStatus(url(first))).toBe(101);
    expect(await upgradeStatus(url(first))).toBe(401);
    const late = await ticket();
    now += 61_000;
    expect(await upgradeStatus(url(late))).toBe(401);

    const local = await rawRequest(server.url, { method: 'POST', path: '/api/auth/ticket' });
    expect(local.status).toBe(400);
  });

  it('accepts the session cookie with the app Origin only', async () => {
    const ada = await grant('editor');
    const signIn = await rawRequest(server.url, {
      method: 'POST',
      path: '/api/auth/session',
      headers: { host: PUBLIC_HOST, origin: PUBLIC },
      body: JSON.stringify({ token: ada.token }),
    });
    const cookie = String(signIn.headers['set-cookie']).split(';')[0] as string;
    const url = `${syncBase()}/plan?lineage=${lineage}`;
    expect(await upgradeStatus(url, { cookie, origin: PUBLIC })).toBe(101);
    expect(await upgradeStatus(url, { cookie })).toBe(403);
    expect(await upgradeStatus(url, { cookie, origin: 'https://attacker.example' })).toBe(403);
  });

  it(`caps one grant at ${MAX_SOCKETS_PER_GRANT} open sockets`, async () => {
    const viewer = await grant('viewer');
    for (let i = 0; i < MAX_SOCKETS_PER_GRANT; i++) await rawSocket(bearer(viewer));
    const url = `${syncBase()}/plan?lineage=${lineage}`;
    expect(await upgradeStatus(url, bearer(viewer))).toBe(429);
    const other = await grant('viewer', 'human', 'Other');
    expect(await upgradeStatus(url, bearer(other))).toBe(101);
  });
});

describe('shared sync: ending access', () => {
  it('closes the sockets of a revoked grant at once, and only those', async () => {
    const ada = await grant('editor', 'human', 'Ada');
    const bob = await grant('editor', 'human', 'Bob');
    const adaSocket = await rawSocket(bearer(ada));
    const bobSocket = await rawSocket(bearer(bob));
    await server.api(OWNER).revokeAccess(ada.grant.id);
    expect(await adaSocket.closed).toBe(CLOSE_ACCESS_REVOKED);
    await sleep(50);
    expect(bobSocket.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('closes the sockets of a session that signs out', async () => {
    const ada = await grant('editor');
    const signIn = await rawRequest(server.url, {
      method: 'POST',
      path: '/api/auth/session',
      headers: { host: PUBLIC_HOST, origin: PUBLIC },
      body: JSON.stringify({ token: ada.token }),
    });
    const cookie = String(signIn.headers['set-cookie']).split(';')[0] as string;
    const sessionSocket = await rawSocket({ cookie, origin: PUBLIC });
    const tokenSocket = await rawSocket(bearer(ada));
    await rawRequest(server.url, {
      method: 'POST',
      path: '/api/auth/logout',
      headers: { host: PUBLIC_HOST, origin: PUBLIC, cookie },
    });
    expect(await sessionSocket.closed).toBe(CLOSE_ACCESS_REVOKED);
    await sleep(50);
    expect(tokenSocket.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('shared sync: presence is checked against the connection', () => {
  it("rewrites the actor of a client's presence, and drops server-only fields", async () => {
    const viewerAccess = await grant('viewer');
    const observerAccess = await grant('viewer', 'human', 'Observer');
    const viewer = client(bearer(viewerAccess));
    const observer = client(bearer(observerAccess));
    await Promise.all([viewer.synced, observer.synced]);
    viewer.provider.awareness.setLocalState({
      actor: { id: 'system', kind: 'system', name: 'OpenBoard', color: '#f00' },
      agent: { status: 'writing', session: 'x', at: new Date().toISOString() },
      live: { sessions: [], at: new Date().toISOString() },
      cursor: { x: 5, y: 6 },
    });
    const seen = await waitFor(
      () =>
        observer.provider.awareness.getStates().get(viewer.ydoc.clientID) as
          | Record<string, unknown>
          | undefined,
      { what: "the viewer's presence" },
    );
    expect(seen).toEqual({
      actor: { id: viewerAccess.grant.actorId, kind: 'human', name: 'OpenBoard', color: '#f00' },
      cursor: { x: 5, y: 6 },
    });
  });

  it("refuses an entry under another client's id, and an oversized one", async () => {
    await server.api(OWNER).apply('plan', {
      ops: [
        { op: 'add_node', id: 'n_one', node: { type: 'note', title: 'One' } },
        { op: 'add_node', id: 'n_two', node: { type: 'note', title: 'Two' } },
      ],
    });
    const editorAccess = await grant('editor', 'human', 'Ed');
    const editor = client(bearer(editorAccess));
    await editor.synced;
    editor.provider.awareness.setLocalState({
      actor: { id: editorAccess.grant.actorId, kind: 'human', name: 'Ed' },
      selection: { nodeIds: ['n_one'], edgeIds: [], at: '2026-11-12T10:00:00.000Z' },
    });
    const api = server.api(OWNER);
    await waitFor(async () => (await api.selection('plan')).nodeIds.length > 0, {
      what: 'the selection',
    });

    const mallory = await grant('viewer', 'human', 'Mallory');
    const { ws } = await rawSocket(bearer(mallory));
    ws.send(
      awarenessMessage([
        {
          id: editor.ydoc.clientID,
          clock: 1000,
          state: {
            actor: { id: editorAccess.grant.actorId, kind: 'human', name: 'Ed' },
            selection: { nodeIds: ['n_two'], edgeIds: [], at: '2026-11-12T11:00:00.000Z' },
          },
        },
        { id: 424242, clock: 1, state: { actor: OWNER, blob: 'x'.repeat(20_000) } },
      ]),
    );
    await sleep(150);
    const selection = await api.selection('plan');
    expect(selection.nodeIds).toEqual(['n_one']);
    expect(selection.by?.id).toBe(editorAccess.grant.actorId);
    expect(editor.provider.awareness.getStates().has(424242)).toBe(false);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});
