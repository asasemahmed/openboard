import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Actor, OpenBoardError } from '@openboard/core';
import { type OpenBoardServer, startServer } from '@openboard/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect } from './index.js';

const OWNER: Actor = { id: 'owner', kind: 'human', name: 'Owner' };

let root: string;
let server: OpenBoardServer;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'openboard-sdk-shared-')));
  server = await startServer({ root, port: 0, shared: true });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function failure(promise: Promise<unknown>): Promise<OpenBoardError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenBoardError);
    return error as OpenBoardError;
  }
  throw new Error('expected the call to fail');
}

describe('a client with a token', () => {
  it('takes its identity from the server and acts as the grant', async () => {
    // The owner at this machine manages access through the same client.
    const owner = connect({ url: server.url, actor: OWNER });
    await owner.createBoard({ name: 'Plan' });
    const made = await owner.grantAccess({ label: 'CI agent', role: 'editor', kind: 'agent' });
    expect(made.inviteUrl).toBeUndefined();

    const bot = connect({ url: server.url, token: made.token, name: 'Nightly' });
    expect(bot.actor.id).toBe('unknown');
    const applied = await bot.apply('plan', {
      ops: [{ op: 'add_node', node: { type: 'note', title: 'From CI' } }],
    });
    expect(applied.status).toBe('applied');
    expect(bot.actor).toEqual({ id: made.grant.actorId, kind: 'agent', name: 'Nightly' });
    expect(await bot.whoami()).toMatchObject({ role: 'editor', via: 'token', shared: true });
    const board = await owner.getBoard('plan');
    expect(Object.values(board.nodes)[0]?.createdBy).toBe(made.grant.actorId);

    const list = await owner.listAccess();
    expect(list.grants.map((g) => g.id)).toEqual([made.grant.id]);
    expect(list.grants[0]?.lastUsedAt).toBeDefined();
    expect((await owner.revokeAccess(made.grant.id)).revokedAt).toBeDefined();
    expect((await failure(bot.listBoards())).code).toBe('unauthorized');
  });

  it('is refused what its role does not include, and a wrong token is unauthorized', async () => {
    const owner = connect({ url: server.url, actor: OWNER });
    await owner.createBoard({ name: 'Plan' });
    const { token } = await owner.grantAccess({ label: 'Reader', role: 'viewer', kind: 'human' });
    const viewer = connect({ url: server.url, token });
    expect((await viewer.outline('plan')).boardId).toBe('plan');
    const refused = await failure(
      viewer.apply('plan', { ops: [{ op: 'add_node', node: { type: 'note', title: 'x' } }] }),
    );
    expect(refused.code).toBe('forbidden');
    expect(refused.message).toContain('"board.edit"');
    expect((await failure(viewer.listAccess())).code).toBe('forbidden');
    const ticket = await viewer.syncTicket();
    expect(ticket.ticket.length).toBeGreaterThanOrEqual(43);

    const wrong = connect({ url: server.url, token: 'ob_aaaaaaaaaaaaaaaa_' + 'A'.repeat(43) });
    expect((await failure(wrong.outline('plan'))).code).toBe('unauthorized');
  });
});

describe('error mapping without an OpenBoard body', () => {
  const answering = (status: number, headers: Record<string, string> = {}) =>
    connect({
      url: 'http://127.0.0.1:9',
      actor: OWNER,
      fetch: async () => new Response('<html>no</html>', { status, headers }),
    });

  it('maps 401 to unauthorized and 429 to rate_limited with the wait', async () => {
    expect((await failure(answering(401).listBoards())).code).toBe('unauthorized');
    const limited = await failure(answering(429, { 'retry-after': '12' }).listBoards());
    expect(limited.code).toBe('rate_limited');
    expect(limited.details).toEqual({ retryAfterSeconds: 12 });
  });

  it('needs an actor or a token', () => {
    expect(() => connect({ url: 'http://127.0.0.1:9' })).toThrow(/actor .* or a token/);
  });
});
