import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import type { Actor } from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Boards } from './boards.js';
import { createHttpApp } from './http.js';
import { projectPaths } from './paths.js';
import { LocalBoardApi } from './service.js';
import { removeRoot, tempRoot, waitFor } from './testing.js';

const BOT: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };

let root: string;
let boards: Boards;
let http: Server;
let port: number;

beforeEach(async () => {
  root = await tempRoot();
  boards = new Boards(projectPaths(root));
  await boards.start();
  const app = createHttpApp({
    boards,
    version: 'test',
    root,
    security: () => ({ port, checkHost: true }),
    log: () => {},
    url: () => `http://127.0.0.1:${port}`,
    mounts: new Map(),
  });
  http = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  port = (http.address() as AddressInfo).port;
  await new LocalBoardApi(boards, BOT).createBoard({ name: 'Plan' });
});

afterEach(async () => {
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await boards.close();
  await removeRoot(root);
});

describe('question long-poll', () => {
  it('releases the waiter when the HTTP client disconnects', async () => {
    const api = new LocalBoardApi(boards, BOT);
    const ask = await api.ask('plan', { question: 'Q' });
    const room = await boards.get('plan');
    const req = request({
      host: '127.0.0.1',
      port,
      path: `/api/boards/plan/asks/${ask.id}?waitMs=60000`,
      headers: { 'x-openboard-actor-id': 'bot', 'x-openboard-actor-kind': 'agent' },
      agent: false,
    });
    req.on('error', () => {});
    req.end();
    await waitFor(() => room.waiting === 1, { what: 'the poll to start waiting' });
    req.destroy();
    await waitFor(() => room.waiting === 0, { what: 'the waiter to be released' });
  });

  it('ends an in-process wait when its signal aborts', async () => {
    const api = new LocalBoardApi(boards, BOT);
    const ask = await api.ask('plan', { question: 'Q' });
    const controller = new AbortController();
    const started = Date.now();
    const waiting = api.askResult('plan', ask.id, { waitMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    expect((await waiting).status).toBe('open');
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await boards.get('plan')).waiting).toBe(0);
  });

  it('rejects a bad waitMs and an unknown question', async () => {
    const api = new LocalBoardApi(boards, BOT);
    const ask = await api.ask('plan', { question: 'Q' });
    const res = await fetch(`http://127.0.0.1:${port}/api/boards/plan/asks/${ask.id}?waitMs=soon`);
    expect(res.status).toBe(400);
    const missing = await fetch(`http://127.0.0.1:${port}/api/boards/plan/asks/a_none`);
    expect(missing.status).toBe(404);
  });
});
