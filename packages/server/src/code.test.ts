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
  it('hashes links in the same batch that stores them', async () => {
    const [whole, range, symbol, url] = (await api(ADA).getBoard('plan')).nodes.n?.links ?? [];
    expect(whole?.hash).toBe(hashContent(SOURCE));
    expect(range?.hash).toBe(hashContent('export function foo() {\n  return 1;\n}'));
    expect(symbol?.hash).toBe(hashContent('export const bar = 2;'));
    expect(url?.hash).toBeUndefined();
    expect(range?.hash).toMatch(new RegExp(`^${LINK_HASH_PREFIX}[0-9a-f]{32}$`));
    await boards.code.idle();
    const changes = await api(BOT).changes('plan', { since: 0 });
    expect(changes.changes.every((c) => c.actor === 'ada')).toBe(true);
    const history = await api(ADA).history('plan', { includeMoves: true });
    expect(history.batches.map((b) => b.actor)).toEqual(['ada']);
  });

  it('hashes links stored another way as system upkeep, and answers from the document', async () => {
    const room = await boards.get('plan');
    room.doc.apply(
      [
        {
          op: 'add_node',
          id: 'u',
          node: {
            type: 'code',
            title: 'From a tab',
            links: [{ kind: 'file', target: 'src/a.ts' }],
          },
        },
      ],
      { actor: ADA, source: 'ui' },
    );
    // Asked before the upkeep ran: the pending update is applied first.
    const result = await api(BOT).links('plan');
    expect(result.links.find((l) => l.nodeId === 'u')).toMatchObject({ state: 'ok' });
    expect(room.doc.getNode('u')?.links?.[0]?.hash).toBe(hashContent(SOURCE));
    expect(room.doc.getNode('u')?.updatedBy).toBe('ada');
    const changes = await api(BOT).changes('plan', { since: 0 });
    const upkeep = changes.changes.at(-1);
    expect(upkeep).toMatchObject({ actor: 'system', source: 'code', detail: 'code link hashed' });
    expect(changes.text).toContain(`#${upkeep?.seq} node_updated u "From a tab": code link hashed`);
    const quiet = await api(BOT).changes('plan', { since: 0, excludeSources: ['code', 'layout'] });
    expect(quiet.changes.some((c) => c.source === 'code')).toBe(false);
    expect(quiet.changes.some((c) => c.source === 'ui')).toBe(true);
  });

  it('reports a link it cannot hash as unchecked', async () => {
    await writeFile(file('src/big.txt'), 'x'.repeat(5 * 1024 * 1024 + 10));
    await api(ADA).apply('plan', {
      layout: 'none',
      ops: [
        {
          op: 'add_node',
          id: 'big',
          node: { type: 'code', title: 'Big', links: [{ kind: 'file', target: 'src/big.txt' }] },
        },
      ],
    });
    const entry = (await api(ADA).links('plan')).links.find((l) => l.nodeId === 'big');
    expect(entry).toMatchObject({ state: 'unchecked', detail: 'file too large to check' });
    expect(entry?.link.hash).toBeUndefined();
  });

  it('reports a missing file for a link a tab stored, as the document does', async () => {
    const room = await boards.get('plan');
    room.doc.apply(
      [
        {
          op: 'add_node',
          id: 'm',
          node: {
            type: 'code',
            title: 'Missing',
            links: [{ kind: 'file', target: 'src/none.ts' }],
          },
        },
      ],
      { actor: ADA, source: 'ui' },
    );
    const entry = (await api(ADA).links('plan')).links.find((l) => l.nodeId === 'm');
    expect(entry).toMatchObject({ state: 'missing', detail: 'file missing' });
    expect(room.doc.getNode('m')?.links?.[0]?.stale).toBe(true);
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
    const changes = await api(BOT).changes('plan', { since: 0 });
    expect(changes.text).toContain('"Foo": code link went stale');
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
