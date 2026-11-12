import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Actor, parseBoard, serializeBoard } from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectPaths } from './paths.js';
import { removeRoot, sleep, startTestServer, tempRoot, waitFor } from './testing.js';
import type { OpenBoardServer } from './types.js';

const AGENT: Actor = { id: 'helper', kind: 'agent', name: 'Helper' };
const OTHER: Actor = { id: 'other', kind: 'agent', name: 'Other' };

let root: string;
let server: OpenBoardServer;
let file: string;

const readText = () => readFile(file, 'utf8');

async function addNotes(titles: string[]) {
  return server.api(AGENT).apply('plan', {
    ops: titles.map((title) => ({
      op: 'add_node' as const,
      node: { type: 'note' as const, title },
    })),
  });
}

beforeEach(async () => {
  root = await tempRoot();
  server = await startTestServer(root);
  file = projectPaths(root).boardFile('plan');
  await server.api(AGENT).createBoard({ name: 'Plan' });
});

afterEach(async () => {
  await server.close();
  await removeRoot(root);
});

describe('persistence', () => {
  it('writes the board file in the deterministic format and keeps runtime state out of git', async () => {
    expect(parseBoard(await readText()).id).toBe('plan');
    await addNotes(['One', 'Two']);
    await waitFor(async () => (await readText()).includes('"Two"'), { what: 'the save' });
    const text = await readText();
    const board = await server.api(AGENT).getBoard('plan');
    expect(text).toBe(serializeBoard(board));
    expect(text.endsWith('\n')).toBe(true);
    const local = projectPaths(root).local;
    expect(await readFile(path.join(local, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('restores the board and keeps the cursor growing across a restart', async () => {
    const first = await addNotes(['One', 'Two']);
    await server.close();
    server = await startTestServer(root);
    const api = server.api(OTHER);
    const board = await api.getBoard('plan');
    expect(
      Object.values(board.nodes)
        .map((n) => n.title)
        .sort(),
    ).toEqual(['One', 'Two']);
    const outline = await api.outline('plan');
    expect(outline.cursor).toBe(first.cursor);
    const changes = await api.changes('plan', { since: 0 });
    expect(changes.resync).toBe(false);
    expect(changes.changes.filter((c) => c.kind === 'node_added')).toHaveLength(2);

    const second = await addNotes(['Three']);
    expect(second.cursor).toBeGreaterThan(first.cursor);
  });

  it('reconciles an external edit into the live board and the change feed', async () => {
    const applied = await addNotes(['Draft']);
    const id = applied.applied?.addedNodes[0] as string;
    await waitFor(async () => (await readText()).includes('"Draft"'));
    const board = parseBoard(await readText());
    const node = board.nodes[id];
    if (!node) throw new Error('node missing from file');
    board.nodes[id] = { ...node, title: 'Edited in git' };
    await writeFile(file, serializeBoard(board));

    const api = server.api(AGENT);
    await waitFor(async () => (await api.getBoard('plan')).nodes[id]?.title === 'Edited in git', {
      what: 'the external edit to be reconciled',
    });
    const changes = await api.changes('plan', { since: applied.cursor });
    expect(changes.changes).toEqual([
      expect.objectContaining({ kind: 'node_updated', id, actor: 'system', fields: ['title'] }),
    ]);
  });

  it('picks up an edit made while the server was down', async () => {
    const applied = await addNotes(['Before']);
    const id = applied.applied?.addedNodes[0] as string;
    await server.close();
    const board = parseBoard(await readText());
    board.nodes[id] = { ...(board.nodes[id] as (typeof board.nodes)[string]), title: 'After' };
    await writeFile(file, serializeBoard(board));
    server = await startTestServer(root);
    const api = server.api(AGENT);
    expect((await api.getBoard('plan')).nodes[id]?.title).toBe('After');
    const changes = await api.changes('plan', { since: applied.cursor });
    expect(changes.changes).toEqual([
      expect.objectContaining({ kind: 'node_updated', id, actor: 'system' }),
    ]);
  });

  it('never overwrites a board file that does not parse', async () => {
    await addNotes(['Kept']);
    await waitFor(async () => (await readText()).includes('"Kept"'));
    const conflicted = `<<<<<<< HEAD\n${await readText()}=======\n{}\n>>>>>>> branch\n`;
    await writeFile(file, conflicted);

    const listed = async () =>
      (await server.api(AGENT).listBoards())[0] as unknown as Record<string, unknown>;
    await waitFor(async () => (await listed()).fileStatus === 'conflict', {
      what: 'the conflict to be noticed',
    });
    expect(String((await listed()).fileError)).toContain('not valid JSON');

    // The live board keeps working, but nothing is written.
    const result = await addNotes(['During conflict']);
    expect(result.status).toBe('applied');
    await sleep(600);
    expect(await readText()).toBe(conflicted);

    // Resolving the file makes it the truth again.
    const resolved = parseBoard(
      conflicted.split('=======\n')[0]?.replace('<<<<<<< HEAD\n', '') ?? '',
    );
    await writeFile(file, serializeBoard(resolved));
    await waitFor(async () => (await listed()).fileStatus === 'ok');
    const titles = Object.values((await server.api(AGENT).getBoard('plan')).nodes).map(
      (n) => n.title,
    );
    expect(titles).toEqual(['Kept']);
  });

  it('does not reload its own writes', async () => {
    const applied = await addNotes(['A', 'B', 'C']);
    await waitFor(async () => (await readText()).includes('"C"'));
    const before = await stat(file);
    await sleep(700);
    const api = server.api(AGENT);
    const changes = await api.changes('plan', { since: 0, includeOwn: true, includeMoves: true });
    expect(changes.cursor).toBe(applied.cursor);
    expect(changes.changes.every((c) => c.actor === 'helper')).toBe(true);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it('keeps a board whose file was deleted and writes it again on the next change', async () => {
    await addNotes(['Survivor']);
    await waitFor(async () => (await readText()).includes('"Survivor"'));
    await unlink(file);
    await sleep(300);
    const api = server.api(AGENT);
    expect(Object.values((await api.getBoard('plan')).nodes)).toHaveLength(1);
    await addNotes(['Next']);
    await waitFor(async () => (await readText().catch(() => '')).includes('"Next"'), {
      what: 'the file to be written again',
    });
    expect(await readText()).toContain('"Survivor"');
  });
});
