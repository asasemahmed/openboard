/**
 * Regression tests for the security review of shared mode: each one failed
 * before its fix. Real servers on loopback, real sockets.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import path from 'node:path';
import {
  type Actor,
  type GrantAccessResult,
  type LiveSessions,
  type Presence,
  type Role,
} from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { MAX_BODY_BYTES } from './http.js';
import { redactPresenceState } from './live.js';
import { findRunningServer, projectPaths } from './paths.js';
import { MAX_SOCKETS_PER_GRANT } from './sync.js';
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
const SECRET = 'cat ~/.ssh/id_ed25519';

let root: string;
let server: OpenBoardServer;
let lineage: string;
const providers: WebsocketProvider[] = [];
const sockets: WebSocket[] = [];

beforeEach(async () => {
  root = await tempRoot();
  server = await startTestServer(root, { shared: true, publicUrl: PUBLIC });
  await server.api(OWNER).createBoard({ name: 'Plan' });
  lineage = await lineageOf(server, 'plan');
});

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.close();
  await removeRoot(root);
});

const grant = (role: Role, kind: 'human' | 'agent' = 'human') =>
  server.api(OWNER).grantAccess({ label: `${role} ${kind}`, role, kind });
const bearer = (access: GrantAccessResult) => ({ authorization: `Bearer ${access.token}` });
const remote = (headers: Record<string, string> = {}) => ({ host: PUBLIC_HOST, ...headers });
const localHost = () => new URL(server.url).host;

/** An editor agent at work: a claim through the API, then a hook report, in one session. */
async function agentAtWork(): Promise<GrantAccessResult> {
  const agent = await grant('editor', 'agent');
  const headers = remote({ ...bearer(agent), 'x-openboard-session': 's-1' });
  const node = await server.api(OWNER).apply('plan', {
    ops: [{ op: 'add_node', ref: 'n', node: { type: 'note', title: 'Target' } }],
  });
  const id = node.applied?.addedNodes[0] as string;
  const claim = await rawRequest(server.url, {
    method: 'POST',
    path: '/api/boards/plan/claims',
    headers,
    body: JSON.stringify({ nodeIds: [id] }),
  });
  expect(claim.status).toBe(200);
  // Reported last, so the presence entry is `working` with the summary as its detail.
  const report = await rawRequest(server.url, {
    method: 'POST',
    path: '/api/activity',
    headers,
    body: JSON.stringify({
      session: 's-1',
      kind: 'tool_start',
      tool: 'Bash',
      summary: SECRET,
      label: 'fix the deploy key',
    }),
  });
  expect(report.status).toBe(200);
  return agent;
}

function withHeaders(headers: Record<string, string>): typeof globalThis.WebSocket {
  class HeaderSocket extends WebSocket {
    constructor(address: string, protocols?: string | string[]) {
      super(address, protocols, { headers });
    }
  }
  return HeaderSocket as unknown as typeof globalThis.WebSocket;
}

function client(headers: Record<string, string>) {
  const provider = new WebsocketProvider(
    `${server.url.replace('http', 'ws')}/sync`,
    'plan',
    new Y.Doc(),
    { WebSocketPolyfill: withHeaders(headers), params: { lineage }, disableBc: true },
  );
  providers.push(provider);
  return provider;
}

function states(provider: WebsocketProvider): Presence[] {
  return [...provider.awareness.getStates().values()] as Presence[];
}

const agentEntry = (provider: WebsocketProvider) =>
  states(provider).find((s) => s.agent !== undefined && s.actor.kind === 'agent');
const liveEntry = (provider: WebsocketProvider) =>
  states(provider).find((s) => s.live !== undefined)?.live as LiveSessions | undefined;

describe('agent activity detail is for roles that edit boards', () => {
  it('leaves summaries, labels and steps out of GET /api/sessions for viewers and commenters', async () => {
    await agentAtWork();
    const read = async (headers: Record<string, string>) => {
      const res = await rawRequest(server.url, { path: '/api/sessions', headers });
      expect(res.status).toBe(200);
      return res;
    };
    for (const role of ['viewer', 'commenter'] as const) {
      const res = await read(remote(bearer(await grant(role))));
      expect(res.text).not.toContain(SECRET);
      expect(res.text).not.toContain('deploy key');
      const [session] = res.json.sessions;
      expect(session).toMatchObject({ id: 's-1', status: 'active', recent: [] });
      expect(session.current).toBeUndefined();
      expect(session.label).toBeUndefined();
    }
    for (const headers of [remote(bearer(await grant('editor'))), { host: localHost() }]) {
      const res = await read(headers);
      expect(res.json.sessions[0].current.summary).toBe(SECRET);
      expect(res.json.sessions[0].label).toBe('fix the deploy key');
    }
  });

  it('redacts agent presence and the session list in awareness, per connection', async () => {
    await agentAtWork();
    const viewer = client(remote(bearer(await grant('viewer'))));
    const commenter = client(remote(bearer(await grant('commenter'))));
    const editor = client(remote(bearer(await grant('editor'))));
    const owner = client({ host: localHost() });

    for (const full of [editor, owner]) {
      await waitFor(() => agentEntry(full)?.agent?.detail?.includes(SECRET), {
        what: 'detail for a role that edits',
      });
      await waitFor(() => liveEntry(full)?.sessions[0]?.current?.summary === SECRET, {
        what: 'the full session list',
      });
    }
    for (const redacted of [viewer, commenter]) {
      const agent = await waitFor(() => agentEntry(redacted), { what: 'agent presence' });
      expect(agent.agent?.status).toBe('working');
      expect(agent.agent?.detail).toBeUndefined();
      expect(agent.agent?.focus).toBeUndefined();
      const live = await waitFor(() => liveEntry(redacted), { what: 'the session list' });
      expect(live.sessions[0]).toMatchObject({ id: 's-1', recent: [] });
      expect(JSON.stringify(states(redacted))).not.toContain(SECRET);
      expect(JSON.stringify(states(redacted))).not.toContain('deploy key');
    }

    // Later updates are redacted too, not just the first snapshot.
    const agentId = agentEntry(owner)?.actor.id as string;
    server.api({ id: agentId, kind: 'agent', name: 'A' }).reportActivity({
      session: 's-1',
      kind: 'tool_end',
      tool: 'Bash',
      summary: `${SECRET} --again`,
    });
    await waitFor(() => liveEntry(owner)?.sessions[0]?.recent.length === 1, {
      what: 'the step to reach the owner',
    });
    await waitFor(() => liveEntry(viewer)?.at === liveEntry(owner)?.at, {
      what: 'the viewer to receive the same update',
    });
    expect(JSON.stringify(states(viewer))).not.toContain(SECRET);
  });

  it('redacts the answer to a query-awareness message as well', async () => {
    await agentAtWork();
    const viewer = await grant('viewer');
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/sync/plan?lineage=${lineage}`, {
      headers: remote(bearer(viewer)),
    });
    sockets.push(ws);
    const received: Buffer[] = [];
    ws.on('message', (data: Buffer) => received.push(data));
    await new Promise((resolve) => ws.on('open', resolve));
    await waitFor(() => received.length >= 2, { what: 'the handshake' });
    ws.send(Uint8Array.of(3));
    await waitFor(() => received.filter((m) => m[0] === 1).length >= 2, { what: 'the answer' });
    const text = Buffer.concat(received).toString('utf8');
    expect(text).toContain('"agent"');
    expect(text).not.toContain(SECRET);
  });
});

describe('the local-trust rule', () => {
  it('treats any header a relay adds as forwarding, not only the best-known ones', async () => {
    const plain = await rawRequest(server.url, {
      path: '/api/boards',
      headers: { host: localHost() },
    });
    expect(plain.status).toBe(200);
    for (const header of [
      'x-original-forwarded-for',
      'x-forwarded-server',
      'x-forwarded-ssl',
      'cf-ray',
      'cdn-loop',
      'fly-request-id',
      'x-envoy-external-address',
      'tailscale-user-login',
      'fastly-client-ip',
    ]) {
      const res = await rawRequest(server.url, {
        path: '/api/boards',
        headers: { host: localHost(), [header]: '203.0.113.9' },
      });
      expect({ header, status: res.status }).toEqual({ header, status: 401 });
    }
  });

  it('applies the same rule to socket upgrades', async () => {
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${server.url.replace('http', 'ws')}/sync/plan?lineage=${lineage}`, {
        headers: { host: localHost(), 'x-original-forwarded-for': '203.0.113.9' },
      });
      sockets.push(ws);
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => resolve(101));
      ws.on('error', () => {});
    });
    expect(status).toBe(401);
  });
});

describe('resource limits', () => {
  it('does not count a refused WebSocket handshake against the grant', async () => {
    const editor = await grant('editor');
    const port = Number(new URL(server.url).port);
    // Valid credentials, but no Sec-WebSocket-Key: ws refuses the handshake.
    const broken = () =>
      new Promise<string>((resolve) => {
        const socket = netConnect(port, '127.0.0.1');
        let out = '';
        socket.on('data', (d) => {
          out += d.toString();
        });
        socket.on('close', () => resolve(out));
        socket.on('error', () => resolve(out));
        socket.write(
          `GET /sync/plan?lineage=${lineage} HTTP/1.1\r\nHost: ${PUBLIC_HOST}\r\nAuthorization: Bearer ${editor.token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
    for (let i = 0; i < MAX_SOCKETS_PER_GRANT + 1; i++) {
      expect((await broken()).split('\r\n')[0]).toMatch(/^HTTP\/1\.1 400/);
    }
    const provider = client(remote(bearer(editor)));
    await waitFor(() => provider.wsconnected, { what: 'a real socket to open' });
  });

  it('caps request bodies on mounted routes as on the API', async () => {
    let reached = 0;
    server.mount('/echo', async (request) => {
      reached++;
      return new Response(String((await request.text()).length));
    });
    const viewer = await grant('viewer');
    const big = 'x'.repeat(MAX_BODY_BYTES + 1);
    const res = await rawRequest(server.url, {
      method: 'POST',
      path: '/echo',
      headers: remote({ ...bearer(viewer), 'content-type': 'text/plain' }),
      body: big,
    });
    expect(res.status).toBe(413);
    expect(reached).toBe(0);
    const ok = await rawRequest(server.url, {
      method: 'POST',
      path: '/echo',
      headers: remote({ ...bearer(viewer), 'content-type': 'text/plain' }),
      body: 'hello',
    });
    expect(ok.text).toBe('5');
  });
});

describe('presence colors', () => {
  it('drops a presence color that is not one', async () => {
    const editor = client(remote(bearer(await grant('editor'))));
    const owner = client({ host: localHost() });
    await waitFor(() => editor.wsconnected && owner.wsconnected, { what: 'both sockets' });
    editor.awareness.setLocalState({
      actor: { id: 'x', kind: 'human', name: 'Eve', color: 'url(//evil.example/p)' },
    });
    const seen = await waitFor(() => states(owner).find((s) => s.actor?.name === 'Eve'), {
      what: "the editor's presence",
    });
    expect(seen.actor.color).toBeUndefined();
  });
});

describe('server.json from the project directory', () => {
  it('never contacts or deletes a record that names another machine', async () => {
    const other = await tempRoot();
    try {
      const file = projectPaths(other).serverInfo;
      await mkdir(path.dirname(file), { recursive: true });
      for (const url of ['http://203.0.113.7:4747', 'https://board.example.com', 'http://evil']) {
        await writeFile(file, JSON.stringify({ pid: process.pid, port: 4747, url, root: other }));
        const started = Date.now();
        expect(await findRunningServer(other)).toBeNull();
        // No health request went out (it would wait for its timeout), and the file stays.
        expect(Date.now() - started).toBeLessThan(200);
        expect(existsSync(file)).toBe(true);
      }
      await sleep(0);
    } finally {
      await removeRoot(other);
    }
  });
});

describe('redactPresenceState', () => {
  it('keeps who and the coarse status, and drops detail, focus, labels and steps', () => {
    const at = '2026-11-12T10:00:00.000Z';
    const agent = { status: 'working', detail: SECRET, focus: ['n1'], session: 's', at };
    expect(redactPresenceState({ actor: OWNER, agent, cursor: { x: 1, y: 2 } })).toEqual({
      actor: OWNER,
      agent: { status: 'working', session: 's', at },
      cursor: { x: 1, y: 2 },
    });
    const session = {
      id: 's',
      actor: 'a',
      label: 'deploy',
      status: 'active',
      startedAt: at,
      lastAt: at,
      current: { tool: 'Bash', summary: SECRET, since: at },
      recent: [{ at, tool: 'Bash', summary: SECRET }],
      counts: { tools: 1, errors: 0 },
      children: [],
    };
    const out = redactPresenceState({ actor: OWNER, live: { sessions: [session], at } });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain('deploy');
    const human = { actor: OWNER, cursor: { x: 0, y: 0 } };
    expect(redactPresenceState(human)).toBe(human);
    expect(redactPresenceState(null)).toBeNull();
  });
});
