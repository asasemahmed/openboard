import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Actor, BoardApi } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { type OpenBoardServer, startServer } from '../lib/server.js';
import { captureIo, serverWorks, tempDir } from '../testing/helpers.js';
import { initCommand } from './init.js';
import { policyCommand, policySetCommand, policyUnsetCommand } from './policy.js';
import { decideCommand, historyCommand, proposalsCommand, undoCommand } from './review.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const BOT: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };

/** A project with a running server, a task by Ada, and a pending proposal by Bot that changes it. */
async function withProposal(
  run: (ctx: {
    root: string;
    server: OpenBoardServer;
    ada: BoardApi;
    bot: BoardApi;
    proposalId: string;
    task: string;
  }) => Promise<void>,
) {
  const root = await tempDir();
  await initCommand(captureIo(root));
  const server = await startServer({ root, port: 0 });
  try {
    const ada = server.api(ADA);
    const bot = server.api(BOT);
    const made = await ada.apply('main', {
      ops: [{ op: 'add_node', ref: 't', node: { type: 'task', title: 'Ship', status: 'todo' } }],
    });
    const task = made.refs.t as string;
    const proposed = await bot.apply('main', {
      reason: 'Mark it done',
      ops: [
        { op: 'update_node', id: task, patch: { status: 'done' } },
        { op: 'add_node', node: { type: 'note', title: 'Shipped' } },
      ],
    });
    expect(proposed.status).toBe('proposed');
    await run({ root, server, ada, bot, proposalId: proposed.proposalId as string, task });
  } finally {
    await server.close();
  }
}

describe('policy without a server', () => {
  it('shows the defaults, then sets and unsets modes in config.json', async () => {
    const root = await tempDir();
    await initCommand(captureIo(root));
    const shown = captureIo(root);
    expect(await policyCommand(shown, { root })).toBe(0);
    expect(shown.out()).toContain(
      'Review policy (the defaults; .openboard/config.json does not exist yet):',
    );
    expect(shown.out()).toContain('  default  review_destructive');
    for (const mode of ['auto', 'review_destructive', 'review_all', 'locked']) {
      expect(shown.out()).toMatch(new RegExp(`^ {2}${mode} +\\S`, 'm'));
    }

    const set = captureIo(root);
    await policySetCommand(set, 'review_all', { root });
    expect(set.out()).toBe('Agents without a mode of their own now use review_all.\n');
    await policySetCommand(captureIo(root), 'locked', { root, agent: 'bot' });
    const file = path.join(root, '.openboard/config.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      policy: { default: 'review_all', agents: { bot: 'locked' } },
    });

    const json = captureIo(root);
    await policyCommand(json, { root, json: true });
    expect(JSON.parse(json.out())).toMatchObject({
      source: 'file',
      policy: { default: 'review_all', agents: { bot: 'locked' } },
    });

    const unset = captureIo(root);
    await policyUnsetCommand(unset, { root, agent: 'bot' });
    expect(unset.out()).toBe('Agent bot now uses the default, review_all.\n');
    const again = captureIo(root);
    await policyUnsetCommand(again, { root, agent: 'bot' });
    expect(again.out()).toBe(
      'Agent bot has no mode of its own; it uses the default, review_all.\n',
    );
  });

  it('refuses an unknown mode and a broken config file', async () => {
    const root = await tempDir();
    await expect(policySetCommand(captureIo(root), 'yolo', { root })).rejects.toThrow(
      'unknown mode "yolo" (choose one of: auto, review_destructive, review_all, locked)',
    );
    await initCommand(captureIo(root));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(root, '.openboard/config.json'), '{"version": 2}');
    await expect(policyCommand(captureIo(root), { root })).rejects.toThrow(
      /config file is invalid/,
    );
  });
});

describe.skipIf(!serverWorks)('with a running server', () => {
  it('policy goes through the server and takes effect at once', async () => {
    await withProposal(async ({ root, bot }) => {
      await policySetCommand(captureIo(root), 'locked', { root, agent: 'bot' });
      const shown = captureIo(root);
      await policyCommand(shown, { root });
      expect(shown.out()).toContain('from the running server; saved in .openboard/config.json');
      expect(shown.out()).toMatch(/agent bot +locked/);
      const refused = await bot.apply('main', {
        ops: [{ op: 'add_node', node: { type: 'note', title: 'x' } }],
      });
      expect(refused.errors?.[0]?.code).toBe('forbidden');
    });
  });

  it('lists proposals, accepts part of one with a note, then rejects the rest', async () => {
    await withProposal(async ({ root, ada, bot, proposalId, task }) => {
      const list = captureIo(root);
      await proposalsCommand(list, undefined, { root });
      expect(list.out()).toContain(`Proposal ${proposalId} by Bot (agent)`);
      expect(list.out()).toContain('#0 [review] Update "Ship": status todo → done');
      expect(list.out()).toContain('openboard accept <id>');

      const accepted = captureIo(root);
      await decideCommand(accepted, 'accept', proposalId, undefined, {
        root,
        items: '0',
        note: 'Yes, it shipped.',
      });
      expect(accepted.out()).toContain(`Proposal ${proposalId} is now pending.`);
      expect(accepted.out()).toMatch(/#0 +accepted +Update "Ship"/);
      expect((await ada.getBoard('main')).nodes[task]?.status).toBe('done');

      const rejected = captureIo(root);
      await decideCommand(rejected, 'reject', proposalId, 'main', { root });
      expect(rejected.out()).toContain('is now partly accepted.');

      const inbox = await bot.inbox('main');
      expect(inbox.text).toContain('  | Yes, it shipped.');
      expect(inbox.items[0]?.from).toBe('cli');

      await expect(
        decideCommand(captureIo(root), 'accept', proposalId, undefined, { root }),
      ).rejects.toThrow(/already partly_accepted/);
      await expect(
        decideCommand(captureIo(root), 'accept', proposalId, undefined, { root, items: 'a' }),
      ).rejects.toThrow('--items a: give item numbers separated by commas, like 0,2');

      const json = captureIo(root);
      await proposalsCommand(json, undefined, { root, json: true, all: true });
      expect(JSON.parse(json.out())[0]).toMatchObject({
        id: proposalId,
        status: 'partly_accepted',
      });
    });
  });

  it('shows history and undoes a batch and an actor', async () => {
    await withProposal(async ({ root, ada, bot, task }) => {
      const applied = await bot.apply('main', {
        reason: 'Add a note',
        ops: [{ op: 'add_node', ref: 'n', node: { type: 'note', title: 'Bot note' } }],
      });
      const note = applied.refs.n as string;

      const history = captureIo(root);
      await historyCommand(history, undefined, { root, limit: 5 });
      const lines = history.out().split('\n');
      expect(lines[0]).toMatch(/^BATCH +AT +ACTOR +SOURCE +SUMMARY +NOTES$/);
      expect(lines[1]).toMatch(/^b_\w+ +\S+ +bot +ops +Added 1 node +"Add a note"$/);
      const botBatch = /^(b_\w+)/.exec(lines[1] ?? '')?.[1] as string;

      const json = captureIo(root);
      await historyCommand(json, 'main', { root, actor: 'ada', json: true });
      const adaBatches = JSON.parse(json.out()) as Array<{ id: string; actor: string }>;
      expect(adaBatches.map((b) => b.actor)).toEqual(['ada']);

      const undone = captureIo(root);
      await undoCommand(undone, [botBatch], { root });
      expect(undone.out()).toMatch(new RegExp(`undid 1 batch \\(${botBatch}\\)`));
      expect((await ada.getBoard('main')).nodes[note]).toBeUndefined();

      const byActor = captureIo(root);
      await undoCommand(byActor, [], { root, actor: 'ada', all: true });
      expect(byActor.out()).toContain('undid 1 batch');
      expect((await ada.getBoard('main')).nodes[task]).toBeUndefined();

      await expect(undoCommand(captureIo(root), [], { root })).rejects.toThrow(/name a batch/);
      await expect(undoCommand(captureIo(root), [], { root, all: true })).rejects.toThrow(
        '--all needs --actor <id>',
      );
      await expect(undoCommand(captureIo(root), [botBatch], { root })).rejects.toThrow(
        /already undone/,
      );
    });
  });
});

describe('without a server', () => {
  it('history, undo and review say they need one', async () => {
    const root = await tempDir();
    await initCommand(captureIo(root));
    await expect(historyCommand(captureIo(root), undefined, { root })).rejects.toThrow(
      /History needs the running server, and none is running for .*; start it with `openboard start`/,
    );
    await expect(undoCommand(captureIo(root), ['b_x'], { root })).rejects.toThrow(
      /Undo needs the running server/,
    );
    await expect(proposalsCommand(captureIo(root), undefined, { root })).rejects.toThrow(
      /Reviewing proposals needs the running server/,
    );
    await expect(
      decideCommand(captureIo(root), 'accept', 'p_x', undefined, { root }),
    ).rejects.toThrow(/Accepting a proposal needs the running server/);
  });
});
