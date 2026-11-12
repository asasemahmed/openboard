import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { type Actor, DEFAULT_CONFIG, type NodeTypeDef, type ProjectConfig } from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Boards } from './boards.js';
import { ChangeFeed } from './feed.js';
import { createHttpApp } from './http.js';
import { projectPaths } from './paths.js';
import { LocalBoardApi } from './service.js';
import { removeRoot, sleep, tempRoot, waitFor } from './testing.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const BOT: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };

const BUG: NodeTypeDef = {
  label: 'Bug',
  fields: [{ key: 'severity', label: 'Severity', kind: 'select', options: ['low', 'high'] }],
};
const withBug = (bug: NodeTypeDef): ProjectConfig => ({
  ...DEFAULT_CONFIG,
  nodeTypes: { 'x:bug': bug },
});

let root: string;
let boards: Boards;

const api = (actor: Actor) => new LocalBoardApi(boards, actor);

beforeEach(async () => {
  root = await tempRoot();
  boards = new Boards(projectPaths(root));
  await boards.start();
  await api(ADA).createBoard({ name: 'Plan' });
  await api(ADA).apply('plan', {
    ops: [{ op: 'add_node', id: 'h1', node: { type: 'task', title: 'Ada task' } }],
  });
});

afterEach(async () => {
  await boards.close();
  await removeRoot(root);
});

describe('inbox long-poll', () => {
  it('returns as soon as a decision on the proposal arrives', async () => {
    const proposed = await api(BOT).apply('plan', {
      ops: [{ op: 'update_node', id: 'h1', patch: { status: 'done' } }],
    });
    expect(proposed.status).toBe('proposed');
    const started = Date.now();
    const waiting = api(BOT).inbox('plan', { waitMs: 20_000 });
    await sleep(50);
    expect((await boards.get('plan')).waiting).toBe(1);
    await api(ADA).decideProposal('plan', proposed.proposalId as string, { action: 'accept' });
    const inbox = await waiting;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(inbox.items.map((i) => i.kind)).toEqual(['decision']);
    expect((await boards.get('plan')).waiting).toBe(0);
  });

  it('returns at once when something unseen is there, and the empty inbox when time is up', async () => {
    await api(ADA).comment('plan', { body: 'Hi', mentions: ['bot'] });
    const started = Date.now();
    expect((await api(BOT).inbox('plan', { waitMs: 20_000 })).items).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1000);
    const empty = await api(BOT).inbox('plan', { waitMs: 100 });
    expect(empty.items).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  it('releases the waiter when an HTTP client disconnects, and on close', async () => {
    const app = createHttpApp({
      boards,
      version: 'test',
      root,
      security: () => ({ port, checkHost: true }),
      log: () => {},
      url: () => `http://127.0.0.1:${port}`,
      mounts: new Map(),
    } as unknown as Parameters<typeof createHttpApp>[0]);
    const http: Server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
    const port = (http.address() as AddressInfo).port;
    try {
      const room = await boards.get('plan');
      const req = request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/boards/plan/inbox',
        headers: {
          'content-type': 'application/json',
          'x-openboard-actor-id': 'bot',
          'x-openboard-actor-kind': 'agent',
        },
        agent: false,
      });
      req.on('error', () => {});
      req.end(JSON.stringify({ waitMs: 60_000 }));
      await waitFor(() => room.waiting === 1, { what: 'the poll to wait' });
      req.destroy();
      await waitFor(() => room.waiting === 0, { what: 'the waiter to be released' });

      const pending = api(BOT).inbox('plan', { waitMs: 60_000 });
      await waitFor(() => room.waiting === 1, { what: 'the second poll' });
      await room.close();
      expect((await pending).items).toEqual([]);
    } finally {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});

describe('changes from the start', () => {
  it('reads from cursor 0, and asks for a re-read when history no longer reaches back', async () => {
    const result = await api(BOT).changes('plan', { since: 0 });
    expect(result.resync).toBe(false);
    expect(result.changes.map((c) => c.id)).toContain('h1');

    const file = `${projectPaths(root).local}/short.changes.jsonl`;
    const feed = await ChangeFeed.open(file, { retain: 2 });
    const doc = (await boards.get('plan')).doc;
    const off = feed.attach(doc);
    for (const title of ['A', 'B', 'C']) {
      doc.apply([{ op: 'add_node', node: { type: 'note', title } }], { actor: ADA });
    }
    off();
    const since = feed.since(0);
    expect(since.resync).toBe(true);
    expect(since.entries).toHaveLength(2);
  });
});

describe('declared types at acceptance', () => {
  it('turns accepted items that no longer fit their type into conflicts', async () => {
    await boards.config.set(withBug(BUG));
    const proposed = await api(BOT).apply('plan', {
      ops: [
        { op: 'update_node', id: 'h1', patch: { title: 'Reviewed' } },
        {
          op: 'add_node',
          ref: 'b',
          node: { type: 'x:bug', title: 'Crash', props: { severity: 'low' } },
        },
        { op: 'add_edge', edge: { type: 'relates_to', source: '$b', target: 'h1' } },
      ],
    });
    await boards.config.set({
      ...DEFAULT_CONFIG,
      policy: { default: 'review_all', agents: {} },
      nodeTypes: {},
    });
    // Proposed under review_all, then the type changes: "low" is no longer allowed.
    const second = await api(BOT).apply('plan', {
      ops: [
        {
          op: 'add_node',
          ref: 'c',
          node: { type: 'x:bug', title: 'Leak', props: { severity: 'low' } },
        },
      ],
    });
    expect(second.status).toBe('proposed');
    await boards.config.set({
      ...withBug({
        ...BUG,
        fields: [{ key: 'severity', label: 'Severity', kind: 'select', options: ['high'] }],
      }),
      policy: { default: 'review_all', agents: {} },
    });
    const decided = await api(ADA).decideProposal('plan', second.proposalId as string, {
      action: 'accept',
    });
    expect(decided.items[0]?.status).toBe('conflict');
    expect(decided.items[0]?.conflict).toContain('no longer matches its declared type');
    expect(decided.status).toBe('rejected');
    expect(
      Object.values((await api(ADA).getBoard('plan')).nodes).map((n) => n.title),
    ).not.toContain('Leak');
    expect(proposed.status).toBe('proposed');
    const first = await api(ADA).decideProposal('plan', proposed.proposalId as string, {
      action: 'accept',
    });
    expect(first.items.map((i) => i.status)).toEqual(['accepted', 'conflict', 'conflict']);
    expect(first.items[2]?.conflict).toContain('depends on item 1');
    expect((await api(ADA).getBoard('plan')).nodes.h1?.title).toBe('Reviewed');
  });
});
