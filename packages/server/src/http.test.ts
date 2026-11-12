import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, rawRequest, removeRoot, startTestServer, tempRoot } from './testing.js';
import type { OpenBoardServer } from './types.js';

const ALICE = {
  'x-openboard-actor-id': 'alice-agent',
  'x-openboard-actor-name': 'Alice',
  'x-openboard-actor-kind': 'agent',
};
const BOB = {
  'x-openboard-actor-id': 'bob-agent',
  'x-openboard-actor-name': 'Bob',
  'x-openboard-actor-kind': 'agent',
};

const THREE_NODES = [
  { op: 'add_node', ref: 'goal', node: { type: 'frame', title: 'Launch' } },
  { op: 'add_node', ref: 'api', node: { type: 'task', title: 'Build the API', parent: '$goal' } },
  { op: 'add_node', ref: 'docs', node: { type: 'task', title: 'Write docs', parent: '$goal' } },
  { op: 'add_edge', edge: { type: 'depends_on', source: '$docs', target: '$api' } },
];

let root: string;
let server: OpenBoardServer;

beforeEach(async () => {
  root = await tempRoot();
  server = await startTestServer(root);
});

afterEach(async () => {
  await server.close();
  await removeRoot(root);
});

describe('HTTP API', () => {
  it('reports health', async () => {
    const res = await api(server, 'GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, version: server.info.version, pid: process.pid, root });
  });

  it('creates, lists and gets boards', async () => {
    const created = await api(server, 'POST', '/api/boards', { name: 'Release Plan!' }, ALICE);
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({
      id: 'release-plan',
      name: 'Release Plan!',
      nodeCount: 0,
      edgeCount: 0,
      fileStatus: 'ok',
    });

    const clash = await api(server, 'POST', '/api/boards', { name: 'x', id: 'release-plan' });
    expect(clash.status).toBe(409);
    expect(clash.json.error.code).toBe('board_exists');

    const list = await api(server, 'GET', '/api/boards');
    expect(list.status).toBe(200);
    expect(list.json.map((b: { id: string }) => b.id)).toEqual(['release-plan']);
    expect(list.json[0].fileStatus).toBe('ok');

    const board = await api(server, 'GET', '/api/boards/release-plan');
    expect(board.status).toBe(200);
    expect(board.json).toMatchObject({
      schemaVersion: 1,
      id: 'release-plan',
      nodes: {},
      edges: {},
    });
    expect(board.headers['x-openboard-file-status']).toBe('ok');
  });

  it('round-trips apply, read, outline and changes with cursors and attribution', async () => {
    await api(server, 'POST', '/api/boards', { name: 'Plan' }, ALICE);
    const applied = await api(
      server,
      'POST',
      '/api/boards/plan/apply',
      { ops: THREE_NODES },
      ALICE,
    );
    expect(applied.status).toBe(200);
    expect(applied.json.status).toBe('applied');
    expect(Object.keys(applied.json.refs).sort()).toEqual(['api', 'docs', 'goal']);
    expect(applied.json.applied.addedNodes).toHaveLength(3);
    const cursor = applied.json.cursor as number;
    expect(cursor).toBeGreaterThanOrEqual(4);

    const read = await api(server, 'POST', '/api/boards/plan/read', { detail: 'full' }, BOB);
    expect(read.json.cursor).toBe(cursor);
    expect(read.json.nodes).toHaveLength(3);
    expect(read.json.edges).toHaveLength(1);
    expect(read.json.text).toContain('Build the API');
    const apiNode = read.json.nodes.find((n: { id: string }) => n.id === applied.json.refs.api);
    expect(apiNode).toMatchObject({ createdBy: 'alice-agent', parent: applied.json.refs.goal });

    const outline = await api(server, 'POST', '/api/boards/plan/outline', {}, BOB);
    expect(outline.json).toMatchObject({ boardId: 'plan', cursor, nodeCount: 3, edgeCount: 1 });
    expect(outline.json.frames[0]).toMatchObject({ title: 'Launch', counts: { task: 2 } });

    // Bob sees Alice's changes; Alice does not see her own by default.
    const bobChanges = await api(server, 'POST', '/api/boards/plan/changes', { since: 0 }, BOB);
    expect(bobChanges.json.resync).toBe(false);
    expect(bobChanges.json.cursor).toBe(cursor);
    const kinds = bobChanges.json.changes.map((c: { kind: string }) => c.kind);
    expect(kinds.filter((k: string) => k === 'node_added')).toHaveLength(3);
    expect(kinds).toContain('edge_added');
    expect(kinds).not.toContain('node_moved');
    for (const change of bobChanges.json.changes) expect(change.actor).toBe('alice-agent');
    expect(bobChanges.json.text).toContain('Alice');

    const own = await api(server, 'POST', '/api/boards/plan/changes', { since: 0 }, ALICE);
    expect(own.json.changes).toEqual([]);
    const withMoves = await api(
      server,
      'POST',
      '/api/boards/plan/changes',
      { since: 0, includeOwn: true, includeMoves: true },
      ALICE,
    );
    expect(withMoves.json.changes.length).toBe(cursor);

    // Agents may change each other's work only with a review policy that allows it.
    const config = await api(
      server,
      'PUT',
      '/api/config',
      { version: 1, policy: { default: 'review_destructive', agents: { 'bob-agent': 'auto' } } },
      { 'x-openboard-actor-id': 'carol', 'x-openboard-actor-kind': 'human' },
    );
    expect(config.status).toBe(200);
    const later = await api(
      server,
      'POST',
      '/api/boards/plan/apply',
      {
        ops: [{ op: 'update_node', id: applied.json.refs.api, patch: { status: 'done' } }],
      },
      BOB,
    );
    expect(later.json.cursor).toBeGreaterThan(cursor);
    const since = await api(server, 'POST', '/api/boards/plan/changes', { since: cursor }, ALICE);
    expect(since.json.changes).toEqual([
      expect.objectContaining({ kind: 'node_updated', actor: 'bob-agent', fields: ['status'] }),
    ]);
  });

  it('decodes a percent-encoded, non-ASCII actor name', async () => {
    await api(server, 'POST', '/api/boards', { name: 'Plan' });
    const name = 'Zoë 東京';
    const headers = {
      'x-openboard-actor-id': 'zoe',
      'x-openboard-actor-name': encodeURIComponent(name),
      'x-openboard-actor-kind': 'agent',
    };
    const res = await api(
      server,
      'POST',
      '/api/boards/plan/apply',
      {
        ops: [{ op: 'add_node', node: { type: 'note', title: 'Hello' } }],
      },
      headers,
    );
    expect(res.json.status).toBe('applied');
    const board = await api(server, 'GET', '/api/boards/plan');
    expect(board.json.actors.zoe).toEqual({ id: 'zoe', kind: 'agent', name });

    // A name that is not valid percent-encoding is taken verbatim.
    const raw = await api(
      server,
      'POST',
      '/api/boards/plan/apply',
      {
        ops: [{ op: 'add_node', node: { type: 'note', title: 'Again' } }],
      },
      { ...headers, 'x-openboard-actor-id': 'pct', 'x-openboard-actor-name': '100%' },
    );
    expect(raw.json.status).toBe('applied');
    expect((await api(server, 'GET', '/api/boards/plan')).json.actors.pct.name).toBe('100%');
  });

  it('attributes requests without actor headers to the anonymous agent', async () => {
    await api(server, 'POST', '/api/boards', { name: 'Plan' });
    await api(server, 'POST', '/api/boards/plan/apply', {
      ops: [{ op: 'add_node', node: { type: 'note', title: 'Hi' } }],
    });
    const board = await api(server, 'GET', '/api/boards/plan');
    expect(board.json.actors.anonymous).toEqual({
      id: 'anonymous',
      kind: 'agent',
      name: 'Anonymous agent',
    });
    const bad = await api(server, 'GET', '/api/boards', undefined, {
      'x-openboard-actor-id': 'not valid!',
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('invalid_request');
  });

  it('dry run validates and changes nothing', async () => {
    await api(server, 'POST', '/api/boards', { name: 'Plan' });
    const before = await api(server, 'GET', '/api/boards/plan');
    const dry = await api(server, 'POST', '/api/boards/plan/apply', {
      ops: THREE_NODES,
      dryRun: true,
    });
    expect(dry.json.status).toBe('valid');
    expect(dry.json.cursor).toBe(0);
    const after = await api(server, 'GET', '/api/boards/plan');
    expect(after.json).toEqual(before.json);

    const badDry = await api(server, 'POST', '/api/boards/plan/apply', {
      ops: [{ op: 'remove_node', id: 'nope' }],
      dryRun: true,
    });
    expect(badDry.json.status).toBe('invalid');
    expect(badDry.json.errors[0]).toMatchObject({ index: 0, code: 'not_found' });
  });

  it('refuses an invalid batch with indexed errors and changes nothing', async () => {
    await api(server, 'POST', '/api/boards', { name: 'Plan' });
    const res = await api(server, 'POST', '/api/boards/plan/apply', {
      ops: [
        { op: 'add_node', ref: 'a', node: { type: 'note', title: 'Fine' } },
        { op: 'add_edge', edge: { type: 'relates_to', source: '$a', target: '$missing' } },
        { op: 'add_node', node: { type: 'note', title: 'Typo', bdy: 'x' } },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('invalid');
    const indexes = res.json.errors.map((e: { index: number }) => e.index);
    expect(indexes).toEqual([1, 2]);
    expect(res.json.errors[1].message).toContain('bdy');
    expect((await api(server, 'GET', '/api/boards/plan')).json.nodes).toEqual({});
  });

  it('returns error JSON for unknown boards, bad bodies and bad ids', async () => {
    const missing = await api(server, 'POST', '/api/boards/nope/read', {});
    expect(missing.status).toBe(404);
    expect(missing.json.error).toMatchObject({ code: 'board_not_found' });
    expect(missing.text).not.toContain('    at ');

    await api(server, 'POST', '/api/boards', { name: 'Plan' });
    const notJson = await rawRequest(server.url, {
      method: 'POST',
      path: '/api/boards/plan/read',
      body: '{nope',
    });
    expect(notJson.status).toBe(400);
    expect(notJson.json.error.code).toBe('invalid_request');

    const badQuery = await api(server, 'POST', '/api/boards/plan/read', { maxTokens: 5 });
    expect(badQuery.status).toBe(400);
    expect(badQuery.json.error.message).toContain('maxTokens');

    const noOps = await api(server, 'POST', '/api/boards/plan/apply', { ops: [] });
    expect(noOps.status).toBe(400);

    const badCreate = await api(server, 'POST', '/api/boards', { name: '' });
    expect(badCreate.status).toBe(400);

    const traversal = await api(server, 'GET', '/api/boards/..%2F..%2Fetc');
    expect(traversal.status).toBe(400);
    expect(traversal.json.error.code).toBe('invalid_request');

    const unknownRoute = await api(server, 'GET', '/api/nothing');
    expect(unknownRoute.status).toBe(404);
    expect(unknownRoute.json.error).toBeDefined();

    const badScope = await api(server, 'POST', '/api/boards/plan/layout', { scope: 'nope' });
    expect(badScope.status).toBe(400);
  });

  it('refuses oversized bodies', async () => {
    await api(server, 'POST', '/api/boards', { name: 'Plan' });
    const huge = JSON.stringify({
      ops: [{ op: 'add_node', node: { type: 'note', title: 'x'.repeat(3 * 1024 * 1024) } }],
    });
    // The server answers 413 as soon as it sees Content-Length; a client still
    // writing the rest of the body may see the connection reset instead.
    const res = await rawRequest(server.url, {
      method: 'POST',
      path: '/api/boards/plan/apply',
      body: huge,
    }).catch((error: NodeJS.ErrnoException) => ({ status: error.code, json: null }));
    if (res.status !== 'ECONNRESET' && res.status !== 'EPIPE') {
      expect(res.status).toBe(413);
      expect(res.json.error.code).toBe('invalid_request');
    }
    expect((await api(server, 'GET', '/api/boards/plan')).json.nodes).toEqual({});
    expect((await api(server, 'GET', '/api/health')).status).toBe(200);
  });

  it('returns the selection as empty when nobody has selected anything', async () => {
    await api(server, 'POST', '/api/boards', { name: 'Plan' });
    const res = await api(server, 'GET', '/api/boards/plan/selection');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ boardId: 'plan', by: null, nodeIds: [], edgeIds: [] });
  });
});

describe('local security', () => {
  const port = () => String(server.info.port);

  it('rejects non-loopback Host headers', async () => {
    const evil = await rawRequest(server.url, {
      path: '/api/health',
      headers: { host: `attacker.example:${port()}` },
    });
    expect(evil.status).toBe(403);
    expect(evil.json.error.code).toBe('forbidden');

    for (const host of [`localhost:${port()}`, `127.0.0.1:${port()}`, `[::1]:${port()}`]) {
      const ok = await rawRequest(server.url, { path: '/api/health', headers: { host } });
      expect(ok.status, host).toBe(200);
    }
    const wrongPort = await rawRequest(server.url, {
      path: '/api/health',
      headers: { host: 'localhost:1' },
    });
    expect(wrongPort.status).toBe(403);
  });

  it('rejects foreign origins and allows its own and the dev server', async () => {
    const foreign = await rawRequest(server.url, {
      path: '/api/boards',
      headers: { origin: 'https://attacker.example' },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();

    const own = await rawRequest(server.url, {
      path: '/api/boards',
      headers: { origin: `http://localhost:${port()}` },
    });
    expect(own.status).toBe(200);

    const dev = await rawRequest(server.url, {
      path: '/api/boards',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(dev.status).toBe(200);

    const otherLocal = await rawRequest(server.url, {
      path: '/api/boards',
      headers: { origin: 'http://localhost:9999' },
    });
    expect(otherLocal.status).toBe(403);
  });
});

describe('static app', () => {
  it('serves a plain notice without an app directory', async () => {
    const res = await rawRequest(server.url, { path: '/' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('serves files, caches hashed assets, and falls back to index.html', async () => {
    const appDir = path.join(root, 'app');
    await mkdir(path.join(appDir, 'assets'), { recursive: true });
    await writeFile(path.join(appDir, 'index.html'), '<!doctype html><title>OpenBoard</title>');
    await writeFile(path.join(appDir, 'assets', 'index-BkX2a9fQ.js'), 'console.log(1)');
    await writeFile(path.join(root, 'secret.txt'), 'secret');
    const withApp = await startTestServer(await tempRoot(), { appDir });
    try {
      const index = await rawRequest(withApp.url, { path: '/' });
      expect(index.headers['content-type']).toContain('text/html');
      expect(index.headers['cache-control']).toBe('no-cache');

      const asset = await rawRequest(withApp.url, { path: '/assets/index-BkX2a9fQ.js' });
      expect(asset.text).toBe('console.log(1)');
      expect(asset.headers['content-type']).toContain('text/javascript');
      expect(asset.headers['cache-control']).toContain('immutable');

      const route = await rawRequest(withApp.url, { path: '/b/some-board' });
      expect(route.status).toBe(200);
      expect(route.text).toContain('<title>OpenBoard</title>');

      const escape = await rawRequest(withApp.url, { path: '/..%2Fsecret.txt' });
      expect(escape.text).not.toContain('secret');

      const apiMiss = await rawRequest(withApp.url, { path: '/api/nope' });
      expect(apiMiss.status).toBe(404);
      expect(apiMiss.json.error).toBeDefined();
    } finally {
      await withApp.close();
      await removeRoot(withApp.root);
    }
  });

  it('does not remember callers that do not say who they are until they change something', async () => {
    await api(
      server,
      'POST',
      '/api/boards',
      { name: 'Plan' },
      { 'x-openboard-actor-id': 'ada', 'x-openboard-actor-kind': 'human' },
    );
    await api(server, 'POST', '/api/boards/plan/read', {});
    const board = await api(server, 'GET', '/api/boards/plan', undefined, {
      'x-openboard-actor-id': 'ada',
      'x-openboard-actor-kind': 'human',
    });
    expect(Object.keys(board.json.actors)).toEqual([]);
    await api(server, 'POST', '/api/boards/plan/apply', {
      ops: [{ op: 'add_node', node: { type: 'note', title: 'Anon' } }],
    });
    const after = await api(server, 'GET', '/api/boards/plan');
    expect(Object.keys(after.json.actors)).toEqual(['anonymous']);
  });
});
