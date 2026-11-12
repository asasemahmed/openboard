import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Actor, OpenBoardError } from '@openboard/core';
import { type OpenBoardServer, startServer } from '@openboard/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, type OpenBoardClient } from './index.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const BOT: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };

let root: string;
let server: OpenBoardServer;
let ada: OpenBoardClient;
let bot: OpenBoardClient;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'openboard-sdk-')));
  server = await startServer({ root, port: 0 });
  ada = connect({ url: server.url, actor: ADA });
  bot = connect({ url: server.url, actor: BOT });
  await ada.createBoard({ name: 'Plan' });
  await ada.apply('plan', {
    ops: [{ op: 'add_node', id: 'h1', node: { type: 'task', title: 'Payment API' } }],
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OpenBoardError);
    return (error as OpenBoardError).code;
  }
  throw new Error('expected the call to fail');
}

describe('against a real server', () => {
  it('round-trips settings', async () => {
    expect((await bot.getConfig()).policy.default).toBe('review_destructive');
    expect(await code(bot.setConfig({ version: 1, policy: { default: 'auto', agents: {} } }))).toBe(
      'forbidden',
    );
    const set = await ada.setConfig({ version: 1, policy: { default: 'review_all', agents: {} } });
    expect(set.policy.default).toBe('review_all');
    expect((await bot.getConfig()).policy.default).toBe('review_all');
  });

  it('round-trips proposals: list, decide, withdraw', async () => {
    const proposed = await bot.apply('plan', {
      ops: [{ op: 'update_node', id: 'h1', patch: { status: 'done' } }],
    });
    expect(proposed.status).toBe('proposed');
    const pending = await ada.proposals('plan', { status: 'pending' });
    expect(pending.proposals.map((p) => p.id)).toEqual([proposed.proposalId]);
    const decided = await ada.decideProposal('plan', proposed.proposalId as string, {
      action: 'accept',
      note: 'ok',
    });
    expect(decided.status).toBe('accepted');
    expect(await code(ada.decideProposal('plan', 'p_none', { action: 'accept' }))).toBe(
      'not_found',
    );

    const second = await bot.apply('plan', { ops: [{ op: 'remove_node', id: 'h1' }] });
    expect((await bot.withdrawProposal('plan', second.proposalId as string)).status).toBe(
      'withdrawn',
    );
    expect((await ada.proposals('plan', { status: 'all' })).proposals).toHaveLength(2);
  });

  it('round-trips history and undo', async () => {
    await ada.setConfig({ version: 1, policy: { default: 'auto', agents: {} } });
    await bot.apply('plan', { ops: [{ op: 'update_node', id: 'h1', patch: { title: 'X' } }] });
    const history = await ada.history('plan', { actor: 'bot' });
    expect(history.batches).toHaveLength(1);
    const undone = await bot.undo('plan', { batchId: history.batches[0]?.id as string });
    expect(undone.undone).toEqual([history.batches[0]?.id]);
    expect((await ada.getBoard('plan')).nodes.h1?.title).toBe('Payment API');
  });

  it('round-trips comments, threads and the inbox', async () => {
    const c = await ada.comment('plan', { body: 'Look', nodeId: 'h1', mentions: ['bot'] });
    const reply = await bot.comment('plan', { body: 'Done', thread: c.id });
    expect(reply.thread).toBe(c.id);
    const resolved = await ada.resolveThread('plan', c.id);
    expect(resolved.resolvedBy).toBe('ada');
    const inbox = await bot.inbox('plan', { peek: true });
    expect(inbox.items.map((i) => i.kind)).toEqual(['mention']);
    expect((await bot.inbox('plan')).items).toHaveLength(1);
    expect((await bot.inbox('plan')).items).toHaveLength(0);
    expect((await ada.inbox('plan')).items.map((i) => i.kind)).toEqual(['reply']);
  });

  it('round-trips questions, with a long-poll that returns on the answer', async () => {
    const ask = await bot.ask('plan', { question: 'Ship it?', options: ['yes', 'no'] });
    const waiting = bot.askResult('plan', ask.id, { waitMs: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await code(bot.answerAsk('plan', ask.id, { option: 'yes' }))).toBe('forbidden');
    await ada.answerAsk('plan', ask.id, { option: 'yes' });
    const answered = await waiting;
    expect(answered.status).toBe('answered');
    expect(await code(ada.answerAsk('plan', ask.id, { option: 'no' }))).toBe('conflict');

    const other = await bot.ask('plan', { question: 'Later?' });
    expect((await bot.askResult('plan', other.id, { waitMs: 100 })).status).toBe('open');
    expect((await bot.cancelAsk('plan', other.id)).status).toBe('cancelled');
  });
});
