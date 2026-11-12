import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Actor, serializeBoard } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { type OpenBoardServer, startServer } from '../lib/server.js';
import { captureIo, sampleBoard, serverWorks, tempDir } from '../testing/helpers.js';
import { linksCommand, revisionsCommand } from './code.js';
import { initCommand } from './init.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const SOURCE = 'export function total(items) {\n  return items.reduce((a, b) => a + b, 0);\n}\n';
const hasGit = spawnSync('git', ['--version']).status === 0;

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function withServer(run: (root: string, server: OpenBoardServer) => Promise<void>) {
  const root = await tempDir();
  await initCommand(captureIo(root));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/total.ts'), SOURCE);
  const server = await startServer({ root, port: 0 });
  try {
    await run(root, server);
  } finally {
    await server.close();
  }
}

describe.skipIf(!serverWorks)('openboard links', () => {
  it('lists changed code, refreshes a node, and is clean again', async () => {
    await withServer(async (root, server) => {
      const ada = server.api(ADA);
      const made = await ada.apply('main', {
        ops: [
          {
            op: 'add_node',
            ref: 'c',
            node: {
              type: 'code',
              title: 'total()',
              links: [{ kind: 'file', target: 'src/total.ts', line: 1, endLine: 3 }],
            },
          },
        ],
      });
      const id = made.refs.c as string;
      const hashed = async () => Boolean((await ada.getBoard('main')).nodes[id]?.links?.[0]?.hash);
      await until(hashed, 'the hash');

      const clean = captureIo(root);
      await linksCommand(clean, [], { root });
      expect(clean.out()).toContain('no code link points at changed or missing code');
      const all = captureIo(root);
      await linksCommand(all, ['main'], { root, all: true });
      expect(all.out()).toContain('src/total.ts:1-3 [ok]');

      await writeFile(path.join(root, 'src/total.ts'), SOURCE.replace('a + b', 'a + b.price'));
      const stale = async () =>
        (await ada.links('main', { stale: true })).links.some((l) => l.state === 'stale');
      await until(stale, 'the stale mark');
      const listed = captureIo(root);
      await linksCommand(listed, [], { root });
      expect(listed.out()).toContain(`${id} "total()"`);
      expect(listed.out()).toContain('[stale]');
      expect(listed.out()).toContain('run `openboard links refresh <node id>` to clear the mark.');
      const json = captureIo(root);
      await linksCommand(json, [], { root, json: true });
      expect(JSON.parse(json.out())[0]).toMatchObject({ nodeId: id, state: 'stale' });

      const refreshed = captureIo(root);
      await linksCommand(refreshed, ['refresh', id, 'main'], { root });
      expect(refreshed.out()).toBe('Refreshed the code links of 1 node on main.\n');
      const after = captureIo(root);
      await linksCommand(after, [], { root });
      expect(after.out()).toContain('no code link points at changed or missing code');
      const again = captureIo(root);
      await linksCommand(again, ['refresh'], { root, all: true });
      expect(again.out()).toBe('Nothing to refresh: those links already match the code.\n');

      await expect(linksCommand(captureIo(root), ['refresh'], { root })).rejects.toThrow(
        /name the nodes to refresh/,
      );
    });
  });
});

describe('without a server', () => {
  it('links says it needs one', async () => {
    const root = await tempDir();
    await initCommand(captureIo(root));
    await expect(linksCommand(captureIo(root), [], { root })).rejects.toThrow(
      /Checking code links needs the running server/,
    );
  });
});

describe.skipIf(!hasGit)('openboard revisions', () => {
  async function repo() {
    const dir = await tempDir();
    const env = {
      GIT_CONFIG_GLOBAL: path.join(dir, '.test-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    await writeFile(env.GIT_CONFIG_GLOBAL, '');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    await writeFile(path.join(dir, '.gitignore'), '.test-gitconfig\n');
    await initCommand(captureIo(dir));
    return { dir, env, git };
  }

  it('lists the commits of the board file, with or without a server', async () => {
    const { dir, env, git } = await repo();
    const untracked = captureIo(dir, env);
    await revisionsCommand(untracked, undefined, { root: dir });
    expect(untracked.out()).toContain('is not tracked by git');

    const file = path.join(dir, '.openboard/main.board.json');
    await writeFile(file, serializeBoard(sampleBoard()));
    git('add', '-A');
    git('commit', '-q', '-m', 'First board');
    await writeFile(file, serializeBoard({ ...sampleBoard(), name: 'Launch v2' }));
    git('commit', '-qam', 'Rename the board');
    await writeFile(file, serializeBoard({ ...sampleBoard(), name: 'Launch v3' }));

    const offline = captureIo(dir, env);
    await revisionsCommand(offline, 'main', { root: dir });
    const lines = offline.out().split('\n');
    expect(lines[0]).toMatch(/^REV +DATE +AUTHOR +SUBJECT$/);
    expect(lines[1]).toMatch(/^[0-9a-f]{7,} +\S+ +Test +Rename the board$/);
    expect(lines[2]).toMatch(/First board$/);
    expect(offline.out()).toContain('has changes that are not committed');

    const json = captureIo(dir, env);
    await revisionsCommand(json, undefined, { root: dir, json: true, limit: 1 });
    expect(JSON.parse(json.out())).toMatchObject({ board: 'main', tracked: true, dirty: true });
    expect(JSON.parse(json.out()).revisions).toHaveLength(1);

    if (!serverWorks) return;
    const server = await startServer({ root: dir, port: 0 });
    try {
      const viaServer = captureIo(dir, env);
      await revisionsCommand(viaServer, 'main', { root: dir });
      expect(viaServer.out()).toMatch(/Rename the board\n.*First board\n/);
    } finally {
      await server.close();
    }
  });
});
