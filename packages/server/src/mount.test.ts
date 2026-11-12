import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { api, rawRequest, removeRoot, startTestServer, tempRoot } from './testing.js';
import type { OpenBoardServer } from './types.js';

let root: string | undefined;
let server: OpenBoardServer | undefined;

afterEach(async () => {
  await server?.close();
  if (root) await removeRoot(root);
  server = undefined;
  root = undefined;
});

async function start(options: Parameters<typeof startTestServer>[1] = {}) {
  root = await tempRoot();
  server = await startTestServer(root, options);
  return server;
}

/** Echoes what the mounted handler received. */
async function echo(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return Response.json({
    method: request.method,
    path: url.pathname,
    body: request.method === 'POST' ? await request.text() : null,
  });
}

describe('mount', () => {
  it('routes the path and everything below it, for every method', async () => {
    const s = await start();
    s.mount('/mcp', echo);
    const post = await api(s, 'POST', '/mcp', { hello: 1 });
    expect(post.status).toBe(200);
    expect(post.json).toEqual({ method: 'POST', path: '/mcp', body: '{"hello":1}' });
    const nested = await api(s, 'GET', '/mcp/deep/path');
    expect(nested.json).toMatchObject({ method: 'GET', path: '/mcp/deep/path' });
    const del = await api(s, 'DELETE', '/mcp');
    expect(del.json).toMatchObject({ method: 'DELETE' });
    // A sibling path is not captured.
    const sibling = await api(s, 'GET', '/mcpx');
    expect(sibling.status).toBe(404);
  });

  it('answers 404 under /mcp while nothing is mounted', async () => {
    const s = await start();
    const res = await api(s, 'POST', '/mcp', {});
    expect(res.status).toBe(404);
  });

  it('applies the Host and Origin checks to mounted routes, and allows requests without Origin', async () => {
    const s = await start();
    s.mount('/mcp', echo);
    const port = new URL(s.url).port;
    const badHost = await rawRequest(s.url, {
      path: '/mcp',
      headers: { host: `attacker.example:${port}` },
    });
    expect(badHost.status).toBe(403);
    const badOrigin = await rawRequest(s.url, {
      path: '/mcp',
      headers: { origin: 'https://attacker.example' },
    });
    expect(badOrigin.status).toBe(403);
    const noOrigin = await rawRequest(s.url, { path: '/mcp' });
    expect(noOrigin.status).toBe(200);
  });

  it('refuses built-in, malformed and overlapping paths', async () => {
    const s = await start();
    expect(() => s.mount('/api', echo)).toThrow(/built-in/);
    expect(() => s.mount('/sync/x', echo)).toThrow(/built-in/);
    expect(() => s.mount('mcp', echo)).toThrow(/cannot mount/);
    expect(() => s.mount('/mcp/', echo)).toThrow(/cannot mount/);
    s.mount('/mcp', echo);
    expect(() => s.mount('/mcp/inner', echo)).toThrow(/already mounted/);
  });

  it('takes precedence over the web app', async () => {
    const s = await start({ appDir: path.join(process.cwd(), 'nonexistent-app') });
    s.mount('/tools', echo);
    const res = await api(s, 'GET', '/tools');
    expect(res.json).toMatchObject({ path: '/tools' });
  });
});

describe('GET /api/info', () => {
  it('reports version, root, project name and URL', async () => {
    const s = await start();
    const res = await api(s, 'GET', '/api/info');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      version: s.info.version,
      root: s.root,
      projectName: path.basename(s.root),
      url: s.url,
    });
  });

  it('merges extra fields, from an object or a function of the URL', async () => {
    const s = await start({ info: { feature: { on: true } } });
    expect((await api(s, 'GET', '/api/info')).json.feature).toEqual({ on: true });
    await s.close();
    server = await startTestServer(root as string, {
      info: ({ url }) => ({ mcp: { httpUrl: `${url}/mcp` } }),
    });
    const res = await api(server, 'GET', '/api/info');
    expect(res.json.mcp).toEqual({ httpUrl: `${server.url}/mcp` });
    expect(res.json.url).toBe(server.url);
  });
});
