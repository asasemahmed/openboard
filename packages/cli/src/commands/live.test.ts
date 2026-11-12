import type { Actor } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { reconnectingApi } from '../lib/mcp.js';
import { findRunningServer, type OpenBoardServer, startServer } from '../lib/server.js';
import { captureIo, serverWorks, tempDir } from '../testing/helpers.js';
import { initCommand } from './init.js';
import { activityCommand, snapshotCommand } from './live.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const BOT: Actor = { id: 'claude-code', kind: 'agent', name: 'Claude Code' };

async function withServer(run: (root: string, server: OpenBoardServer) => Promise<void>) {
  const root = await tempDir();
  await initCommand(captureIo(root));
  const server = await startServer({ root, port: 0 });
  try {
    await run(root, server);
  } finally {
    await server.close();
  }
}

describe.skipIf(!serverWorks)('with a running server', () => {
  it('activity prints the session tree, and JSON', async () => {
    await withServer(async (root, server) => {
      const bot = server.api(BOT, { session: 's-main' });
      await bot.reportActivity({ session: 's-main', kind: 'session_start' });
      await bot.reportActivity({
        session: 's-main',
        kind: 'tool_start',
        tool: 'Bash',
        summary: 'pnpm test',
      });
      await bot.reportActivity({
        session: 's-sub',
        parent: 's-main',
        kind: 'subagent_start',
        label: 'Explore',
      });

      const io = captureIo(root);
      expect(await activityCommand(io, { root })).toBe(0);
      expect(io.out()).toContain('s-main');
      expect(io.out()).toContain('Bash');
      expect(io.out()).toContain('s-sub');

      const json = captureIo(root);
      await activityCommand(json, { root, json: true });
      const sessions = JSON.parse(json.out()) as Array<{ id: string; children: string[] }>;
      expect(sessions.find((s) => s.id === 's-main')?.children).toEqual(['s-sub']);
    });
  });

  it('snapshot writes the board as it was at a cursor, in any export format', async () => {
    await withServer(async (root, server) => {
      const ada = server.api(ADA);
      const first = await ada.apply('main', {
        ops: [{ op: 'add_node', node: { type: 'task', title: 'First' } }],
      });
      await ada.apply('main', {
        ops: [{ op: 'add_node', node: { type: 'task', title: 'Second' } }],
      });

      const io = captureIo(root);
      await snapshotCommand(io, String(first.cursor), undefined, { root, format: 'text' });
      expect(io.out()).toContain('"First"');
      expect(io.out()).not.toContain('"Second"');

      const json = captureIo(root);
      await snapshotCommand(json, String(first.cursor), 'main', { root });
      expect(
        Object.values(JSON.parse(json.out()).nodes).map((n) => (n as { title: string }).title),
      ).toEqual(['First']);

      await expect(
        snapshotCommand(captureIo(root), 'yesterday', undefined, { root }),
      ).rejects.toThrow('cursor "yesterday": give a whole number');
    });
  });

  it('gives every client of the stdio path the same agent session', async () => {
    await withServer(async (root, server) => {
      const made = await server.api(ADA).apply('main', {
        ops: [{ op: 'add_node', ref: 't', node: { type: 'task', title: 'Mine' } }],
      });
      const info = await findRunningServer(root);
      if (!info) throw new Error('no server recorded');
      const api = reconnectingApi(BOT, info, async () => info, 'sess-42');
      const claim = await api.claim('main', { nodeIds: [made.refs.t as string] });
      expect(claim.claims[0]).toMatchObject({ by: 'claude-code', session: 'sess-42' });
    });
  });
});

describe('without a server', () => {
  it('activity and snapshot say they need one', async () => {
    const root = await tempDir();
    await initCommand(captureIo(root));
    await expect(activityCommand(captureIo(root), { root })).rejects.toThrow(
      /Activity needs the running server/,
    );
    await expect(snapshotCommand(captureIo(root), '3', undefined, { root })).rejects.toThrow(
      /A snapshot needs the running server/,
    );
  });
});
