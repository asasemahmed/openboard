import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Actor, type BoardApi, LINK_HASH_PREFIX, type Link } from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Boards } from './boards.js';
import { hashContent } from './code.js';
import { projectPaths } from './paths.js';
import { LocalBoardApi } from './service.js';
import { removeRoot, tempRoot, waitFor } from './testing.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const BOT: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };

let root: string;
let boards: Boards;

const api = (actor: Actor): BoardApi => new LocalBoardApi(boards, actor);
const file = (rel: string) => path.join(root, rel);
const SOURCE = [
  'export function foo() {',
  '  return 1;',
  '}',
  '',
  'export const bar = 2;',
  '',
].join('\n');

async function open(): Promise<void> {
  boards = new Boards(projectPaths(root));
  await boards.start();
}

async function links(id = 'n'): Promise<Link[]> {
  await boards.code.idle();
  return (await api(ADA).getBoard('plan')).nodes[id]?.links ?? [];
}

/** Wait until the server has noticed a file change and settled. */
async function settle<T>(check: () => Promise<T>, what: string): Promise<NonNullable<T>> {
  return waitFor(
    async () => {
      await boards.code.idle();
      return check();
    },
    { what, timeoutMs: 8000 },
  );
}

beforeEach(async () => {
  root = await tempRoot();
  await mkdir(file('src'), { recursive: true });
  await writeFile(file('src/a.ts'), SOURCE);
  await open();
  await api(ADA).createBoard({ name: 'Plan' });
  await api(ADA).apply('plan', {
    layout: 'none',
    ops: [
      {
        op: 'add_node',
        id: 'n',
        node: {
          type: 'code',
          title: 'Foo',
          links: [
            { kind: 'file', target: 'src/a.ts' },
            { kind: 'file', target: 'src/a.ts', line: 1, endLine: 3 },
            { kind: 'symbol', target: 'src/a.ts#bar', line: 5 },
            { kind: 'url', target: 'https://example.com' },
          ],
        },
      },
    ],
  });
});

afterEach(async () => {
  await boards.close();
  await removeRoot(root);
});

describe('code links', () => {
  it('fills hashes from the linked content, as system upkeep that is not a batch', async () => {
    const [whole, range, symbol, url] = await links();
    expect(whole?.hash).toBe(hashContent(SOURCE));
    expect(range?.hash).toBe(hashContent('export function foo() {\n  return 1;\n}'));
    expect(symbol?.hash).toBe(hashContent('export const bar = 2;'));
    expect(url?.hash).toBeUndefined();
    expect(range?.hash).toMatch(new RegExp(`^${LINK_HASH_PREFIX}[0-9a-f]{32}$`));
    const board = await api(ADA).getBoard('plan');
    expect(board.nodes.n?.updatedBy).toBe('ada');
    const changes = await api(BOT).changes('plan', { since: 0 });
    expect(changes.changes.at(-1)).toMatchObject({
      actor: 'system',
      kind: 'node_updated',
      fields: ['links'],
    });
    const history = await api(ADA).history('plan', { includeMoves: true });
    expect(history.batches.map((b) => b.actor)).toEqual(['ada']);
  });

  it('normalises line endings before hashing', async () => {
    expect(hashContent('a\nb')).toBe(hashContent('a\nb'));
    await writeFile(file('src/a.ts'), SOURCE.replace(/\n/g, '\r\n'));
    await settle(async () => (await api(ADA).links('plan')).links.length > 0, 'a check');
    const result = await api(ADA).links('plan', { stale: true });
    expect(result.links).toEqual([]);
  });

  it('marks a link stale when its code changes, and says where', async () => {
    await links();
    await writeFile(file('src/a.ts'), SOURCE.replace('return 1;', 'return 42;'));
    const [whole, range, symbol] = await settle(async () => {
      const current = await links();
      return current[1]?.stale ? current : null;
    }, 'the range to turn stale');
    expect(whole?.stale).toBe(true);
    expect(range?.stale).toBe(true);
    expect(symbol?.stale).toBeUndefined();
    const result = await api(BOT).links('plan', { stale: true });
    expect(result.links.map((l) => [l.index, l.state, l.detail])).toEqual([
      [0, 'stale', 'content changed'],
      [1, 'stale', 'content changed at lines 1-3'],
    ]);
    expect(result.text).toContain('#1 file src/a.ts:1-3 [stale]: content changed at lines 1-3');
    expect((await api(BOT).read('plan', { ids: ['n'] })).text).toContain('src/a.ts (stale)');
    expect((await api(BOT).outline('plan')).text).toContain(
      '2 code links point at code that changed since',
    );

    // Changing it back clears the mark.
    await writeFile(file('src/a.ts'), SOURCE);
    await settle(async () => ((await links())[1]?.stale ? null : true), 'the mark to clear');
  });

  it('follows code that moved, without marking it stale', async () => {
    await links();
    await writeFile(file('src/a.ts'), `// header\n// more\n${SOURCE}`);
    const current = await settle(async () => {
      const now = await links();
      return now[1]?.line === 3 ? now : null;
    }, 'the range to move');
    expect(current[1]).toMatchObject({ line: 3, endLine: 5 });
    expect(current[1]?.stale).toBeUndefined();
    expect(current[2]).toMatchObject({ line: 7 });
    expect(current[2]?.endLine).toBeUndefined();
    // The whole-file link cannot move: it is stale.
    expect(current[0]?.stale).toBe(true);
  });

  it('does not move a range whose text now appears twice', async () => {
    await links();
    await writeFile(file('src/a.ts'), `export const bar = 2;\n${SOURCE}`);
    const current = await settle(async () => {
      const now = await links();
      return now[2]?.stale ? now : null;
    }, 'the symbol to turn stale');
    expect(current[2]?.line).toBe(5);
  });

  it('marks links to a deleted file stale, and reports it missing', async () => {
    await links();
    await rm(file('src/a.ts'));
    await settle(async () => ((await links())[1]?.stale ? true : null), 'the links to turn stale');
    const result = await api(ADA).links('plan');
    expect(result.links.find((l) => l.index === 1)).toMatchObject({
      state: 'missing',
      detail: 'file missing',
    });
  });

  it('never reads outside the project', async () => {
    const outside = path.join(await tempRoot(), 'secret.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, file('src/link.txt'));
    await api(ADA).apply('plan', {
      layout: 'none',
      ops: [
        {
          op: 'add_node',
          id: 'o',
          node: {
            type: 'code',
            title: 'Outside',
            links: [
              { kind: 'file', target: '../secret.txt' },
              { kind: 'file', target: outside },
              { kind: 'file', target: 'src/../../x' },
              { kind: 'file', target: 'src/link.txt' },
              { kind: 'file', target: path.join(tmpdir(), 'nope') },
            ],
          },
        },
      ],
    });
    const stored = await links('o');
    expect(stored.every((link) => link.hash === undefined && link.stale === undefined)).toBe(true);
    const result = await api(ADA).links('plan');
    const states = result.links.filter((l) => l.nodeId === 'o').map((l) => l.state);
    expect(states).toEqual(['outside', 'outside', 'outside', 'outside', 'outside']);
    expect(result.links.find((l) => l.nodeId === 'o' && l.index === 3)?.detail).toContain(
      'symlink',
    );
    await rm(path.dirname(outside), { recursive: true, force: true });
  });

  it('writes nothing when nothing changed', async () => {
    await links();
    const before = (await api(ADA).outline('plan')).cursor;
    await writeFile(file('src/a.ts'), SOURCE); // same bytes, new mtime
    await new Promise((resolve) => setTimeout(resolve, 400));
    await boards.code.idle();
    expect((await api(ADA).outline('plan')).cursor).toBe(before);
  });

  it('keeps hashes across a restart and checks every link on load', async () => {
    const hashed = await links();
    await boards.close();
    await writeFile(file('src/a.ts'), SOURCE.replace('return 1;', 'return 2;'));
    await open();
    await api(ADA).getBoard('plan');
    const after = await settle(async () => {
      const now = await links();
      return now[1]?.stale ? now : null;
    }, 'the load check');
    expect(after[1]?.hash).toBe(hashed[1]?.hash);
    expect(after[2]?.stale).toBeUndefined();
  });

  it('refreshes links as a reviewed change: a person directly, an agent through policy', async () => {
    await links();
    await writeFile(file('src/a.ts'), SOURCE.replace('return 1;', 'return 3;'));
    await settle(async () => ((await links())[1]?.stale ? true : null), 'stale');

    const proposed = await api(BOT).refreshLinks('plan', { nodeIds: ['n'] });
    expect(proposed.status).toBe('proposed');

    const result = await api(ADA).refreshLinks('plan', { nodeIds: ['n'] });
    expect(result.status).toBe('applied');
    const refreshed = await links();
    expect(refreshed.every((link) => link.stale === undefined)).toBe(true);
    expect(refreshed[1]?.hash).toBe(hashContent('export function foo() {\n  return 3;\n}'));
    const [batch] = (await api(ADA).history('plan')).batches;
    expect(batch).toMatchObject({ actor: 'ada', reason: 'Refresh code links' });
    expect(batch?.id).toBe(result.batchId);
    // Nothing left to refresh.
    expect((await api(ADA).refreshLinks('plan', { all: true })).batchId).toBeUndefined();
    await expect(api(ADA).refreshLinks('plan', {} as never)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('lets an agent undo its batch even after the server updated its links', async () => {
    await boards.config.set({ version: 1, policy: { default: 'auto', agents: {} } });
    const added = await api(BOT).apply('plan', {
      layout: 'none',
      ops: [
        {
          op: 'add_node',
          id: 'b',
          node: { type: 'code', title: 'Bot code', links: [{ kind: 'file', target: 'src/a.ts' }] },
        },
      ],
    });
    expect((await links('b'))[0]?.hash).toBeDefined();
    const undo = await api(BOT).undo('plan', { batchId: added.batchId as string });
    expect(undo.conflicts).toEqual([]);
    expect((await api(ADA).getBoard('plan')).nodes.b).toBeUndefined();
  });
});
