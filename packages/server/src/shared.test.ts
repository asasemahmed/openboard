import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Actor,
  API_ACTIONS,
  can,
  type GrantAccessResult,
  type Role,
  RoleSchema,
} from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Boards } from './boards.js';
import { createHttpApp, permissionAction, routeTable } from './http.js';
import { startServer } from './server.js';
import { type RawResponse, rawRequest, removeRoot, startTestServer, tempRoot } from './testing.js';
import type { CallerInfo, OpenBoardServer, ServerOptions } from './types.js';

const PUBLIC = 'https://board.example.com';
const PUBLIC_HOST = 'board.example.com';
const OWNER: Actor = { id: 'owner', kind: 'human', name: 'Owner' };
const T0 = Date.parse('2026-11-12T10:00:00.000Z');

let root: string;
let server: OpenBoardServer;
let now: number;

async function start(options: Partial<ServerOptions> = {}): Promise<OpenBoardServer> {
  server = await startTestServer(root, {
    shared: true,
    publicUrl: PUBLIC,
    clock: () => now,
    ...options,
  });
  return server;
}

beforeEach(async () => {
  root = await tempRoot();
  now = T0;
});

afterEach(async () => {
  await server?.close();
  await removeRoot(root);
});

/** A request as a remote caller sees the server: through its public host. */
function remote(
  method: string,
  pathname: string,
  opts: { token?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return rawRequest(server.url, {
    method,
    path: pathname,
    headers: {
      host: PUBLIC_HOST,
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

/** A request from this machine, with no credentials: the owner. */
function local(
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return rawRequest(server.url, {
    method,
    path: pathname,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function grant(
  role: Role,
  kind: 'human' | 'agent' = 'human',
  extra: { label?: string; expiresInHours?: number } = {},
): Promise<GrantAccessResult> {
  return server
    .api(OWNER)
    .grantAccess({ label: extra.label ?? `${role} ${kind}`, role, kind, ...extra });
}

const cookieOf = (res: RawResponse): string => {
  const header = res.headers['set-cookie'];
  const first = Array.isArray(header) ? header[0] : header;
  return (first ?? '').split(';')[0] ?? '';
};

describe('shared mode: who gets in', () => {
  it('refuses remote callers without credentials, everywhere but health, sign-in and the app', async () => {
    await start();
    server.mount('/mcp', () => Response.json({ reached: true }));
    for (const [method, p] of [
      ['GET', '/api/boards'],
      ['GET', '/api/whoami'],
      ['GET', '/api/info'],
      ['POST', '/api/boards/plan/apply'],
      ['GET', '/api/nothing-here'],
      ['POST', '/mcp'],
    ] as const) {
      const res = await remote(method, p, method === 'POST' ? { body: {} } : {});
      expect(res.status, `${method} ${p}`).toBe(401);
      expect(res.json.error.code).toBe('unauthorized');
      expect(res.headers['www-authenticate']).toBe('Bearer realm="openboard"');
    }
    const health = await remote('GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ ok: true, version: server.info.version, shared: true });
    const app = await remote('GET', '/');
    expect(app.status).toBe(200);
    expect(app.headers['referrer-policy']).toBe('no-referrer');
    expect(app.headers['x-frame-options']).toBe('DENY');
  });

  it('trusts the owner at this machine, and nobody a proxy relays', async () => {
    await start();
    const port = new URL(server.url).port;
    const me = await local('GET', '/api/whoami');
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ role: 'owner', via: 'local', shared: true });
    expect(
      (await local('GET', '/api/boards', undefined, { host: `localhost:${port}` })).status,
    ).toBe(200);
    const health = await local('GET', '/api/health');
    expect(health.json).toMatchObject({ root, pid: process.pid, shared: true });

    for (const header of ['x-forwarded-for', 'forwarded', 'x-forwarded-host', 'x-real-ip']) {
      const relayed = await local('GET', '/api/whoami', undefined, { [header]: '203.0.113.7' });
      expect(relayed.status, header).toBe(401);
    }
    const viaPublicHost = await local('GET', '/api/whoami', undefined, { host: PUBLIC_HOST });
    expect(viaPublicHost.status).toBe(401);
    const otherHost = await local('GET', '/api/whoami', undefined, { host: 'attacker.example' });
    expect(otherHost.status).toBe(403);
    const otherOrigin = await remote('GET', '/api/health', {
      headers: { origin: 'https://attacker.example' },
    });
    expect(otherOrigin.status).toBe(403);
    const relayedHealth = await local('GET', '/api/health', undefined, {
      'x-forwarded-for': '1.2.3.4',
    });
    expect(relayedHealth.json).toEqual({ ok: true, version: server.info.version, shared: true });
  });

  it('uses credentials when they are sent, even from this machine, and never falls back on a bad one', async () => {
    await start();
    const viewer = await grant('viewer');
    const me = await local('GET', '/api/whoami', undefined, {
      authorization: `Bearer ${viewer.token}`,
    });
    expect(me.json).toMatchObject({ role: 'viewer', via: 'token' });
    const bad = await local('GET', '/api/whoami', undefined, { authorization: 'Bearer ob_nope' });
    expect(bad.status).toBe(401);
  });

  it('refuses to listen beyond loopback without shared mode, or on every interface without a public URL', async () => {
    await expect(startServer({ root, port: 0, host: '0.0.0.0', shared: false })).rejects.toThrow(
      /no unauthenticated remote mode/,
    );
    await expect(startServer({ root, port: 0, host: '0.0.0.0' })).rejects.toThrow(/publicUrl/);
    await expect(
      startServer({ root, port: 0, shared: true, publicUrl: 'https://x.example/sub' }),
    ).rejects.toThrow(/origin/);
    await expect(
      startServer({ root, port: 0, shared: true, publicUrl: 'ftp://x.example' }),
    ).rejects.toThrow(/http/);
    await start();
  });
});

describe('shared mode: tokens', () => {
  it('pins identity to the grant: headers can rename it but never change its id or kind', async () => {
    await start();
    await server.api(OWNER).createBoard({ name: 'Plan' });
    const bot = await grant('editor', 'agent', { label: 'CI agent' });
    const spoof = {
      'x-openboard-actor-id': 'owner',
      'x-openboard-actor-kind': 'human',
      'x-openboard-actor-name': 'Build%20bot',
    };
    const who = await remote('GET', '/api/whoami', { token: bot.token, headers: spoof });
    expect(who.json).toEqual({
      actor: { id: bot.grant.actorId, kind: 'agent', name: 'Build bot' },
      role: 'editor',
      shared: true,
      via: 'token',
      grantId: bot.grant.id,
    });
    const applied = await remote('POST', '/api/boards/plan/apply', {
      token: bot.token,
      headers: spoof,
      body: { ops: [{ op: 'add_node', node: { type: 'note', title: 'From CI' } }] },
    });
    expect(applied.json.status).toBe('applied');
    const changes = await server.api(OWNER).changes('plan', { since: 0, includeOwn: true });
    expect(changes.changes.map((c) => c.actor)).toEqual([bot.grant.actorId]);
  });

  it('keeps an agent grant out of people-only actions, whatever its role', async () => {
    await start();
    await server.api(OWNER).createBoard({ name: 'Plan' });
    const owned = await server.api(OWNER).apply('plan', {
      ops: [{ op: 'add_node', ref: 'n', node: { type: 'note', title: 'Mine' } }],
    });
    const bot = await grant('editor', 'agent');
    const proposed = await remote('POST', '/api/boards/plan/apply', {
      token: bot.token,
      body: { ops: [{ op: 'update_node', id: owned.refs.n, patch: { title: 'Theirs' } }] },
    });
    expect(proposed.json.status).toBe('proposed');
    const pid = proposed.json.proposalId as string;
    const decide = await remote('POST', `/api/boards/plan/proposals/${pid}/decide`, {
      token: bot.token,
      body: { action: 'accept' },
    });
    expect(decide.status).toBe(403);
    expect(decide.json.error.message).toMatch(/people only/);
    const ask = await remote('POST', '/api/boards/plan/asks', {
      token: bot.token,
      body: { question: 'May I?' },
    });
    expect(ask.status).toBe(201);
    const answer = await remote('POST', `/api/boards/plan/asks/${ask.json.id}/answer`, {
      token: bot.token,
      body: { text: 'Yes' },
    });
    expect(answer.status).toBe(403);
    // A person with editor access may decide.
    const ada = await grant('editor');
    const accepted = await remote('POST', `/api/boards/plan/proposals/${pid}/decide`, {
      token: ada.token,
      body: { action: 'accept' },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.json.status).toBe('accepted');
  });

  it('lets only people with owner access manage access, shows the token once and never the hash', async () => {
    await start();
    const made = await local(
      'POST',
      '/api/access',
      { label: 'Ada', role: 'editor', kind: 'human' },
      {
        'x-openboard-actor-id': 'owner',
        'x-openboard-actor-kind': 'human',
      },
    );
    expect(made.status).toBe(201);
    expect(made.json.token).toMatch(/^ob_[a-z0-9]{16}_/);
    expect(made.json.inviteUrl).toBe(`${PUBLIC}/join#${made.json.token}`);
    const list = await local('GET', '/api/access', undefined, {
      'x-openboard-actor-kind': 'human',
      'x-openboard-actor-id': 'owner',
    });
    expect(list.json.grants).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toContain('secretHash');
    expect(JSON.stringify(list.json)).not.toContain(made.json.token);
    const file = await readFile(path.join(root, '.openboard', '.local', 'access.json'), 'utf8');
    expect(file).not.toContain(made.json.token);

    const editor = await remote('GET', '/api/access', { token: made.json.token });
    expect(editor.status).toBe(403);
    expect(editor.json.error.message).toContain('"access.manage"');
    // A local agent is the owner, but not a person.
    const agent = await local('GET', '/api/access', undefined, {
      'x-openboard-actor-id': 'bot',
      'x-openboard-actor-kind': 'agent',
    });
    expect(agent.status).toBe(403);
    const remoteOwner = await grant('owner');
    const byRemoteOwner = await remote('POST', '/api/access', {
      token: remoteOwner.token,
      body: { label: 'Bot', role: 'owner', kind: 'agent' },
    });
    expect(byRemoteOwner.status).toBe(400);
  });

  it('expires a grant on time and revokes it at once', async () => {
    await start();
    const temp = await grant('viewer', 'human', { expiresInHours: 1 });
    expect((await remote('GET', '/api/whoami', { token: temp.token })).json.expiresAt).toBe(
      new Date(T0 + 3_600_000).toISOString(),
    );
    now += 3_600_001;
    expect((await remote('GET', '/api/whoami', { token: temp.token })).status).toBe(401);

    const ada = await grant('editor');
    expect((await remote('GET', '/api/boards', { token: ada.token })).status).toBe(200);
    const revoked = await local('DELETE', `/api/access/${ada.grant.id}`, undefined, {
      'x-openboard-actor-id': 'owner',
      'x-openboard-actor-kind': 'human',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.json.revokedAt).toBeDefined();
    const after = await remote('GET', '/api/boards', { token: ada.token });
    expect(after.status).toBe(401);
    expect(after.json.error.message).toBe(
      'the access token is not valid: it is wrong, expired or revoked',
    );
    // An in-process session for the grant dies with it too.
    const inProcess = server.api(
      { id: ada.grant.actorId, kind: 'human', name: 'Ada' },
      { role: 'editor', grantId: ada.grant.id },
    );
    await expect(inProcess.listBoards()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('releases the claims and cancels the questions of a revoked agent; its proposals wait for people', async () => {
    await start();
    await server.api(OWNER).createBoard({ name: 'Plan' });
    const owned = await server.api(OWNER).apply('plan', {
      ops: [{ op: 'add_node', ref: 'n', node: { type: 'note', title: 'Mine' } }],
    });
    const bot = await grant('editor', 'agent');
    const claim = await remote('POST', '/api/boards/plan/claims', {
      token: bot.token,
      body: { nodeIds: [owned.refs.n] },
    });
    expect(claim.json.claims).toHaveLength(1);
    const ask = await remote('POST', '/api/boards/plan/asks', {
      token: bot.token,
      body: { question: 'Q?' },
    });
    const proposal = await remote('POST', '/api/boards/plan/apply', {
      token: bot.token,
      body: { ops: [{ op: 'remove_node', id: owned.refs.n }] },
    });
    expect(proposal.json.status).toBe('proposed');
    await server.api(OWNER).revokeAccess(bot.grant.id);
    const room = server.api(OWNER);
    expect((await room.getBoard('plan')).nodes[owned.refs.n as string]).toBeDefined();
    const asks = await room.asks('plan', { status: 'all' });
    expect(asks.asks.find((a) => a.id === ask.json.id)?.status).toBe('cancelled');
    const proposals = await room.proposals('plan');
    expect(proposals.proposals.map((p) => p.status)).toEqual(['pending']);
  });

  it('throttles failed attempts per client and answers 429 with Retry-After', async () => {
    await start();
    const viewer = await grant('viewer');
    const from = (ip: string, token: string) =>
      remote('GET', '/api/whoami', { token, headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < 20; i++) expect((await from('203.0.113.9', 'ob_wrong')).status).toBe(401);
    const blocked = await from('203.0.113.9', viewer.token);
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await from('203.0.113.10', viewer.token)).status).toBe(200);
    now += 10 * 60_000 + 1;
    expect((await from('203.0.113.9', viewer.token)).status).toBe(200);
  });

  it('never echoes a token back in an error', async () => {
    const lines: string[] = [];
    await start({ log: (line) => lines.push(line) });
    const viewer = await grant('viewer');
    const res = await remote('POST', '/api/auth/session', {
      headers: { origin: PUBLIC, 'content-type': 'application/json' },
      body: `{"token": "${viewer.token}"` as unknown,
    });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(viewer.token);
    expect(lines.join('\n')).not.toContain(viewer.token);
  });
});

describe('shared mode: browser sessions', () => {
  const signIn = (token: string, extra: Record<string, string> = {}) =>
    remote('POST', '/api/auth/session', {
      headers: { origin: PUBLIC, ...extra },
      body: { token, name: 'Ada' },
    });

  it('trades an invite token for an HttpOnly, SameSite=Strict, Secure cookie', async () => {
    await start();
    await server.api(OWNER).createBoard({ name: 'Plan' });
    const ada = await grant('editor', 'human', { label: 'Ada laptop' });
    const res = await signIn(ada.token);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      actor: { id: ada.grant.actorId, name: 'Ada' },
      via: 'session',
      role: 'editor',
    });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(
      /^__Host-openboard_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/,
    );
    const cookie = cookieOf(res);
    const who = await remote('GET', '/api/whoami', { cookie });
    expect(who.json).toMatchObject({ via: 'session', actor: { name: 'Ada' } });

    // State-changing cookie requests must carry the app's Origin.
    const body = { ops: [{ op: 'add_node', node: { type: 'note', title: 'x' } }] };
    expect((await remote('POST', '/api/boards/plan/apply', { cookie, body })).status).toBe(403);
    const crossSite = await remote('POST', '/api/boards/plan/apply', {
      cookie,
      body,
      headers: { origin: 'https://attacker.example' },
    });
    expect(crossSite.status).toBe(403);
    const sameSite = await remote('POST', '/api/boards/plan/apply', {
      cookie,
      body,
      headers: { origin: PUBLIC },
    });
    expect(sameSite.json.status).toBe('applied');

    // Sign-in itself is browser-only: no Origin, no session.
    expect((await remote('POST', '/api/auth/session', { body: { token: ada.token } })).status).toBe(
      403,
    );
  });

  it('never keeps a session id the client brought, and ends the previous session', async () => {
    await start();
    const ada = await grant('editor');
    const first = cookieOf(await signIn(ada.token));
    const planted = '__Host-openboard_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const second = await signIn(ada.token, { cookie: `${first}` });
    const secondCookie = cookieOf(second);
    expect(secondCookie).not.toBe(first);
    expect((await remote('GET', '/api/whoami', { cookie: first })).status).toBe(401);
    const third = cookieOf(await signIn(ada.token, { cookie: planted }));
    expect(third).not.toBe(planted);
    expect((await remote('GET', '/api/whoami', { cookie: planted })).status).toBe(401);
  });

  it('logs out, clears the cookie, and survives a restart until then', async () => {
    await start();
    const ada = await grant('editor');
    const cookie = cookieOf(await signIn(ada.token));
    await server.close();
    await start();
    expect((await remote('GET', '/api/whoami', { cookie })).status).toBe(200);
    const out = await remote('POST', '/api/auth/logout', { cookie, headers: { origin: PUBLIC } });
    expect(out.status).toBe(200);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    const after = await remote('GET', '/api/whoami', { cookie });
    expect(after.status).toBe(401);
    expect(String(after.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('uses a plain cookie name without Secure on an http public URL, and ends with its grant', async () => {
    await start({ publicUrl: 'http://board.example.com' });
    const ada = await grant('editor', 'human', { expiresInHours: 2 });
    const res = await remote('POST', '/api/auth/session', {
      headers: { origin: 'http://board.example.com' },
      body: { token: ada.token },
    });
    expect(String(res.headers['set-cookie'])).toMatch(
      /^openboard_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=7200$/,
    );
    const cookie = cookieOf(res);
    now += 2 * 3_600_000 + 1;
    expect((await remote('GET', '/api/whoami', { cookie })).status).toBe(401);
  });

  it('refuses sign-in in local mode', async () => {
    server = await startTestServer(root);
    const res = await local('POST', '/api/auth/session', { token: 'x' }, { origin: server.url });
    expect(res.status).toBe(400);
  });
});

describe('shared mode: what each role may do', () => {
  // The routes and their permissions, from an app that is never served.
  const table = routeTable(
    createHttpApp({
      boards: { access: {} } as unknown as Boards,
      version: 't',
      root: '/',
      security: () => ({ port: 0, checkHost: true }),
      log: () => {},
      url: () => '',
      mounts: new Map(),
    }),
  );
  const PARAMS: Record<string, string> = {
    id: 'plan',
    pid: 'p_missing',
    aid: 'a_missing',
    thread: 'c_missing',
    cursor: '0',
    rev: 'HEAD',
    grant: 'zzzzzzzzzzzzzzzz',
  };

  it('registers every route with a permission, and every BoardApi method has a route', () => {
    expect(table.length).toBeGreaterThan(40);
    const methods = new Set(table.map((r) => r.permission));
    for (const method of Object.keys(API_ACTIONS))
      expect(methods.has(method as never), method).toBe(true);
  });

  for (const role of RoleSchema.options) {
    it(`gives ${role} exactly the routes its role allows`, async () => {
      await start();
      await server.api(OWNER).createBoard({ name: 'Plan' });
      const access = await grant(role);
      for (const spec of table) {
        if (spec.permission === 'public') continue;
        const pathname = spec.path.replace(
          /:([a-z]+)/g,
          (_m, name: string) => PARAMS[name] ?? name,
        );
        const body =
          spec.permission === 'claim'
            ? { nodeIds: ['n_missing'], release: true }
            : spec.method === 'GET' || spec.method === 'DELETE'
              ? undefined
              : {};
        const res = await remote(spec.method, pathname, {
          token: access.token,
          ...(body !== undefined ? { body } : {}),
        });
        const action = permissionAction(spec.permission);
        const label = `${role} ${spec.method} ${spec.path} (${action ?? 'any'})`;
        expect(res.status, label).not.toBe(401);
        const refusedForRole =
          res.status === 403 && String(res.json?.error?.message).includes('your access (');
        expect(refusedForRole, `${label}: ${res.status} ${res.text.slice(0, 200)}`).toBe(
          action !== null && !can(role, action),
        );
      }
    });
  }

  it('enforces a role passed to an in-process session too', async () => {
    await start();
    await server.api(OWNER).createBoard({ name: 'Plan' });
    const viewer = server.api({ id: 'v', kind: 'human', name: 'V' }, { role: 'viewer' });
    await expect(
      viewer.apply('plan', { ops: [{ op: 'add_node', node: { type: 'note', title: 'x' } }] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(viewer.comment('plan', { body: 'hi' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await viewer.outline('plan')).boardId).toBe('plan');
    const commenter = server.api({ id: 'c', kind: 'human', name: 'C' }, { role: 'commenter' });
    expect((await commenter.comment('plan', { body: 'hi' })).author).toBe('c');
    expect(await commenter.whoami()).toMatchObject({
      role: 'commenter',
      via: 'local',
      shared: true,
    });
  });
});

describe('shared mode: info and mounted routes', () => {
  it('shows local paths, the user name and launch commands to owners only', async () => {
    await start({ info: { user: 'sven', mcp: { stdio: { command: '/usr/bin/openboard' } } } });
    const viewer = await grant('viewer');
    const seen = await remote('GET', '/api/info', { token: viewer.token });
    expect(seen.json).toEqual({
      version: server.info.version,
      projectName: path.basename(root),
      url: PUBLIC,
      shared: true,
    });
    const owner = await local('GET', '/api/info');
    expect(owner.json).toMatchObject({ root, user: 'sven', shared: true, publicUrl: PUBLIC });
  });

  it('hands mounted handlers the authenticated caller, without credentials or actor headers', async () => {
    await start();
    const seen: Array<{ caller: CallerInfo; headers: Record<string, string | null> }> = [];
    server.mount('/mcp', (request, caller) => {
      seen.push({
        caller,
        headers: {
          authorization: request.headers.get('authorization'),
          actorId: request.headers.get('x-openboard-actor-id'),
        },
      });
      return Response.json({ ok: true });
    });
    const bot = await grant('commenter', 'agent');
    const res = await remote('POST', '/mcp', {
      token: bot.token,
      headers: { 'x-openboard-actor-id': 'owner' },
      body: {},
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toEqual({
      caller: {
        actor: { id: bot.grant.actorId, kind: 'agent', name: 'commenter agent' },
        role: 'commenter',
        via: 'token',
        shared: true,
        anonymous: false,
        grantId: bot.grant.id,
      },
      headers: { authorization: null, actorId: null },
    });
    await local('POST', '/mcp', {});
    expect(seen[1]?.caller).toMatchObject({ role: 'owner', via: 'local', anonymous: true });
  });
});

describe('local mode keeps its contract', () => {
  it('ignores tokens and takes the actor from headers, as the owner', async () => {
    server = await startTestServer(root);
    const made = await server
      .api(OWNER)
      .grantAccess({ label: 'Ada', role: 'viewer', kind: 'human' });
    const who = await local('GET', '/api/whoami', undefined, {
      authorization: `Bearer ${made.token}`,
      'x-openboard-actor-id': 'ada',
      'x-openboard-actor-kind': 'human',
    });
    expect(who.json).toEqual({
      actor: { id: 'ada', kind: 'human', name: 'ada' },
      role: 'owner',
      shared: false,
      via: 'local',
    });
    expect(server.shared).toBe(false);
    expect((await local('GET', '/api/health')).json).toEqual({
      ok: true,
      version: server.info.version,
      pid: process.pid,
      root,
    });
  });
});
