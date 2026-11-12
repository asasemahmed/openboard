import { type Actor, OpenBoardError } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { connect, OpenBoardClient } from './index.js';

const actor: Actor = { id: 'agent-1', kind: 'agent', name: 'Zoë 100%' };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: Call, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(respond: Responder = () => json({})) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call, init);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(respond?: Responder, timeoutMs?: number) {
  const fake = fakeFetch(respond);
  const api = connect({ url: 'http://127.0.0.1:4747', actor, fetch: fake.fetch, timeoutMs });
  return { api, calls: fake.calls };
}

async function failure(promise: Promise<unknown>): Promise<OpenBoardError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenBoardError);
    return error as OpenBoardError;
  }
  throw new Error('expected the call to fail');
}

function networkError(code: string): TypeError {
  const cause = Object.assign(new Error(`${code.toLowerCase()} happened`), { code });
  return new TypeError('fetch failed', { cause });
}

describe('routes', () => {
  const cases: Array<{
    name: string;
    call: (api: OpenBoardClient) => Promise<unknown>;
    method: string;
    path: string;
    body?: unknown;
    response?: unknown;
  }> = [
    { name: 'health', call: (a) => a.health(), method: 'GET', path: '/api/health' },
    {
      name: 'listBoards',
      call: (a) => a.listBoards(),
      method: 'GET',
      path: '/api/boards',
      response: [],
    },
    {
      name: 'createBoard',
      call: (a) => a.createBoard({ name: 'Plan', id: 'plan' }),
      method: 'POST',
      path: '/api/boards',
      body: { name: 'Plan', id: 'plan' },
    },
    { name: 'getBoard', call: (a) => a.getBoard('main'), method: 'GET', path: '/api/boards/main' },
    {
      name: 'outline',
      call: (a) => a.outline('main', { maxTokens: 500 }),
      method: 'POST',
      path: '/api/boards/main/outline',
      body: { maxTokens: 500 },
    },
    {
      name: 'outline without options',
      call: (a) => a.outline('main'),
      method: 'POST',
      path: '/api/boards/main/outline',
      body: {},
    },
    {
      name: 'read',
      call: (a) => a.read('main', { types: ['task'], detail: 'full' }),
      method: 'POST',
      path: '/api/boards/main/read',
      body: { types: ['task'], detail: 'full' },
    },
    {
      name: 'changes',
      call: (a) => a.changes('main', { since: 4 }),
      method: 'POST',
      path: '/api/boards/main/changes',
      body: { since: 4 },
    },
    {
      name: 'apply',
      call: (a) => a.apply('main', { ops: [{ op: 'remove_node', id: 'n_1' }], reason: 'cleanup' }),
      method: 'POST',
      path: '/api/boards/main/apply',
      body: { ops: [{ op: 'remove_node', id: 'n_1' }], reason: 'cleanup' },
    },
    {
      name: 'selection',
      call: (a) => a.selection('main'),
      method: 'GET',
      path: '/api/boards/main/selection',
    },
    {
      name: 'layout',
      call: (a) => a.layout('main', { scope: 'all' }),
      method: 'POST',
      path: '/api/boards/main/layout',
      body: { scope: 'all' },
    },
    {
      name: 'proposals',
      call: (a) => a.proposals('main', { status: 'all', maxTokens: 500 }),
      method: 'GET',
      path: '/api/boards/main/proposals?status=all&maxTokens=500',
    },
    {
      name: 'proposals without options',
      call: (a) => a.proposals('main'),
      method: 'GET',
      path: '/api/boards/main/proposals',
    },
    {
      name: 'decideProposal',
      call: (a) => a.decideProposal('main', 'p_1', { action: 'accept', items: [0], note: 'ok' }),
      method: 'POST',
      path: '/api/boards/main/proposals/p_1/decide',
      body: { action: 'accept', items: [0], note: 'ok' },
    },
    {
      name: 'withdrawProposal',
      call: (a) => a.withdrawProposal('main', 'p_1'),
      method: 'POST',
      path: '/api/boards/main/proposals/p_1/withdraw',
      body: {},
    },
    {
      name: 'history',
      call: (a) => a.history('main', { limit: 5, actor: 'bot' }),
      method: 'POST',
      path: '/api/boards/main/history',
      body: { limit: 5, actor: 'bot' },
    },
    {
      name: 'undo',
      call: (a) => a.undo('main', { actorId: 'agent-1', scope: 'last' }),
      method: 'POST',
      path: '/api/boards/main/undo',
      body: { actorId: 'agent-1', scope: 'last' },
    },
    {
      name: 'comment',
      call: (a) => a.comment('main', { body: 'hi', nodeId: 'n_1', mentions: ['agents'] }),
      method: 'POST',
      path: '/api/boards/main/comments',
      body: { body: 'hi', nodeId: 'n_1', mentions: ['agents'] },
    },
    {
      name: 'resolveThread',
      call: (a) => a.resolveThread('main', 'c_1', false),
      method: 'POST',
      path: '/api/boards/main/threads/c_1/resolve',
      body: { resolved: false },
    },
    {
      name: 'inbox',
      call: (a) => a.inbox('main', { since: 3, peek: true }),
      method: 'POST',
      path: '/api/boards/main/inbox',
      body: { since: 3, peek: true },
    },
    {
      name: 'ask',
      call: (a) => a.ask('main', { question: 'Which?', options: ['a', 'b'] }),
      method: 'POST',
      path: '/api/boards/main/asks',
      body: { question: 'Which?', options: ['a', 'b'] },
    },
    {
      name: 'askResult',
      call: (a) => a.askResult('main', 'a_1', { waitMs: 1000 }),
      method: 'GET',
      path: '/api/boards/main/asks/a_1?waitMs=1000',
    },
    {
      name: 'answerAsk',
      call: (a) => a.answerAsk('main', 'a_1', { option: 'a' }),
      method: 'POST',
      path: '/api/boards/main/asks/a_1/answer',
      body: { option: 'a' },
    },
    {
      name: 'cancelAsk',
      call: (a) => a.cancelAsk('main', 'a_1'),
      method: 'POST',
      path: '/api/boards/main/asks/a_1/cancel',
      body: {},
    },
    { name: 'getConfig', call: (a) => a.getConfig(), method: 'GET', path: '/api/config' },
    {
      name: 'setConfig',
      call: (a) => a.setConfig({ version: 1, policy: { default: 'auto', agents: {} } }),
      method: 'PUT',
      path: '/api/config',
      body: { version: 1, policy: { default: 'auto', agents: {} } },
    },
  ];

  for (const c of cases) {
    it(`${c.name} -> ${c.method} ${c.path}`, async () => {
      const { api, calls } = client(() => json(c.response ?? { ok: true }));
      await expect(c.call(api)).resolves.toEqual(c.response ?? { ok: true });
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call?.method).toBe(c.method);
      expect(call?.url).toBe(`http://127.0.0.1:4747${c.path}`);
      expect(call?.body).toEqual(c.body);
      expect(call?.headers['x-openboard-actor-id']).toBe('agent-1');
      expect(call?.headers['x-openboard-actor-kind']).toBe('agent');
      expect(call?.headers['content-type']).toBe(
        c.body === undefined ? undefined : 'application/json',
      );
    });
  }

  it('encodes the actor name so the header stays ASCII', async () => {
    const { api, calls } = client();
    await api.health();
    const name = calls[0]?.headers['x-openboard-actor-name'];
    expect(name).toBe('Zo%C3%AB%20100%25');
    expect(decodeURIComponent(name ?? '')).toBe(actor.name);
    expect(/^[\x21-\x7e]*$/.test(name ?? '')).toBe(true);
  });

  it('path-encodes board ids', async () => {
    const { api, calls } = client();
    await api.getBoard('a/b c');
    expect(calls[0]?.url).toBe('http://127.0.0.1:4747/api/boards/a%2Fb%20c');
  });

  it('keeps a path prefix in the base URL', async () => {
    const fake = fakeFetch();
    const api = connect({ url: 'https://host.example/board-server', actor, fetch: fake.fetch });
    await api.outline('main');
    expect(fake.calls[0]?.url).toBe('https://host.example/board-server/api/boards/main/outline');
  });

  it('rejects an invalid actor or URL up front', () => {
    expect(() => connect({ url: 'nope', actor })).toThrow(OpenBoardError);
    expect(() => connect({ url: 'ftp://x', actor })).toThrow(OpenBoardError);
    expect(() =>
      connect({ url: 'http://127.0.0.1:1', actor: { id: 'bad id', kind: 'human', name: 'x' } }),
    ).toThrow(/invalid actor/);
  });
});

describe('errors', () => {
  it('maps a JSON error body to an OpenBoardError with the same code', async () => {
    const { api } = client(() =>
      json(
        { error: { code: 'board_not_found', message: 'no board "x"', details: { id: 'x' } } },
        404,
      ),
    );
    const error = await failure(api.getBoard('x'));
    expect(error.code).toBe('board_not_found');
    expect(error.message).toBe('no board "x"');
    expect(error.details).toEqual({ id: 'x' });
  });

  it('maps every known code', async () => {
    for (const code of [
      'board_exists',
      'not_found',
      'invalid_request',
      'forbidden',
      'conflict',
    ] as const) {
      const { api } = client(() => json({ error: { code, message: code } }, 400));
      expect((await failure(api.listBoards())).code).toBe(code);
    }
  });

  it('maps a non-JSON error body to internal', async () => {
    const { api } = client(() => new Response('<html>Bad Gateway</html>', { status: 502 }));
    const error = await failure(api.listBoards());
    expect(error.code).toBe('internal');
    expect(error.message).toContain('HTTP 502');
  });

  it('maps an unknown error code to internal', async () => {
    const { api } = client(() => json({ error: { code: 'teapot', message: 'short' } }, 418));
    expect((await failure(api.listBoards())).code).toBe('internal');
  });

  it('maps a non-JSON success body to internal', async () => {
    const { api } = client(() => new Response('hello', { status: 200 }));
    expect((await failure(api.health())).code).toBe('internal');
  });

  it('maps a success body of the wrong shape to internal', async () => {
    const { api } = client(() => json({ boards: [] }));
    const error = await failure(api.listBoards());
    expect(error.code).toBe('internal');
    expect(error.message).toContain('expected a JSON array');
  });

  it('maps a network failure to unavailable and names the URL', async () => {
    const { api } = client(() => {
      throw networkError('ECONNREFUSED');
    });
    const error = await failure(api.listBoards());
    expect(error.code).toBe('unavailable');
    expect(error.message).toContain('http://127.0.0.1:4747/');
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.message).not.toContain('fetch failed');
  });

  it('times out with unavailable', async () => {
    const { api } = client(
      (_call, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      20,
    );
    const error = await failure(api.health());
    expect(error.code).toBe('unavailable');
    expect(error.message).toContain('did not answer within 20 ms');
    expect(error.message).toContain('http://127.0.0.1:4747/');
  });

  it('gives a long-poll more time than it waits', async () => {
    const { api } = client(
      (_call, init) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(json({ id: 'a_1', status: 'open' })), 60);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        }),
      20,
    );
    await expect(api.askResult('main', 'a_1', { waitMs: 50 })).resolves.toMatchObject({
      status: 'open',
    });
    expect((await failure(api.askResult('main', 'a_1'))).code).toBe('unavailable');
  });

  it('times out while reading a slow body', async () => {
    const { api } = client(
      (_call, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
          }),
        ),
      20,
    );
    expect((await failure(api.health())).code).toBe('unavailable');
  });
});

describe('retries', () => {
  it('retries an idempotent read once after a connection reset', async () => {
    let attempts = 0;
    const { api, calls } = client(() => {
      attempts += 1;
      if (attempts === 1) throw networkError('ECONNRESET');
      return json([]);
    });
    await expect(api.listBoards()).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('gives up after one retry', async () => {
    const { api, calls } = client(() => {
      throw networkError('ECONNRESET');
    });
    expect((await failure(api.read('main'))).code).toBe('unavailable');
    expect(calls).toHaveLength(2);
  });

  it('never retries a mutating call', async () => {
    for (const call of [
      (a: OpenBoardClient) => a.apply('main', { ops: [] }),
      (a: OpenBoardClient) => a.createBoard({ name: 'x' }),
      (a: OpenBoardClient) => a.layout('main'),
      (a: OpenBoardClient) => a.undo('main', { batchId: 'b_1' }),
      (a: OpenBoardClient) => a.inbox('main'),
      (a: OpenBoardClient) => a.answerAsk('main', 'a_1', { text: 'x' }),
    ]) {
      const { api, calls } = client(() => {
        throw networkError('ECONNRESET');
      });
      expect((await failure(call(api))).code).toBe('unavailable');
      expect(calls).toHaveLength(1);
    }
  });

  it('does not retry a refused connection', async () => {
    const { api, calls } = client(() => {
      throw networkError('ECONNREFUSED');
    });
    await failure(api.listBoards());
    expect(calls).toHaveLength(1);
  });
});
