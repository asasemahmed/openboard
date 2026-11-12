/** `status`, `boards` and `new` against the board files, with no server running. */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseBoard, serializeBoard } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { captureIo, sampleBoard, tempDir } from '../testing/helpers.js';
import { boardsCommand, newBoardCommand } from './boards.js';
import { initCommand } from './init.js';
import { statusCommand } from './status.js';

async function project() {
  const dir = await tempDir();
  await mkdir(path.join(dir, '.openboard'));
  await writeFile(path.join(dir, '.openboard/main.board.json'), serializeBoard(sampleBoard()));
  return dir;
}

describe('status without a server', () => {
  it('reports not running and counts nodes and edges from the files', async () => {
    const dir = await project();
    const io = captureIo(dir);
    expect(await statusCommand(io, { root: dir })).toBe(0);
    expect(io.out()).toContain('OpenBoard is not running.');
    expect(io.out()).toContain(`Root: ${dir}`);
    expect(io.out()).toMatch(/main\s+Launch\s+4\s+2/);
  });

  it('prints JSON only with --json', async () => {
    const dir = await project();
    const io = captureIo(dir);
    await statusCommand(io, { root: dir, json: true });
    const status = JSON.parse(io.out());
    expect(status).toMatchObject({
      running: false,
      url: null,
      pid: null,
      root: dir,
      initialized: true,
      boards: [{ id: 'main', name: 'Launch', nodeCount: 4, edgeCount: 2 }],
    });
  });

  it('discovers the root from a subdirectory', async () => {
    const dir = await project();
    const sub = path.join(dir, 'src', 'deep');
    await mkdir(sub, { recursive: true });
    const io = captureIo(sub);
    await statusCommand(io, { json: true });
    expect(JSON.parse(io.out()).root).toBe(dir);
  });

  it('says how to start when there is no .openboard', async () => {
    const dir = await tempDir();
    const io = captureIo(dir);
    await statusCommand(io, { root: dir });
    expect(io.out()).toContain('openboard init');
  });

  it('warns about a broken board file and lists the rest', async () => {
    const dir = await project();
    await writeFile(path.join(dir, '.openboard/broken.board.json'), '{ nope');
    const io = captureIo(dir);
    await statusCommand(io, { root: dir, json: true });
    expect(JSON.parse(io.out()).boards).toHaveLength(1);
    expect(io.err()).toMatch(/skipping .*broken\.board\.json: board file is not valid JSON/);
  });
});

describe('boards and new without a server', () => {
  it('lists boards as a table and as JSON', async () => {
    const dir = await project();
    const io = captureIo(dir);
    await boardsCommand(io, { root: dir });
    expect(io.out().split('\n')[0]).toMatch(/^ID\s+NAME\s+NODES\s+EDGES\s+UPDATED$/);

    const json = captureIo(dir);
    await boardsCommand(json, { root: dir, json: true });
    expect(JSON.parse(json.out())).toEqual([
      expect.objectContaining({ id: 'main', name: 'Launch', nodeCount: 4, edgeCount: 2 }),
    ]);
  });

  it('says when there are no boards', async () => {
    const dir = await tempDir();
    const io = captureIo(dir);
    await boardsCommand(io, { root: dir });
    expect(io.out()).toContain('No boards yet');
  });

  it('creates a board file with an id derived from the name', async () => {
    const dir = await project();
    const io = captureIo(dir);
    expect(await newBoardCommand(io, 'Q3 Roadmap Review!', { root: dir })).toBe(0);
    expect(io.out()).toBe('Created board q3-roadmap-review\n');
    const board = parseBoard(
      await readFile(path.join(dir, '.openboard/q3-roadmap-review.board.json'), 'utf8'),
    );
    expect(board.name).toBe('Q3 Roadmap Review!');

    const list = captureIo(dir);
    await boardsCommand(list, { root: dir, json: true });
    expect(JSON.parse(list.out()).map((b: { id: string }) => b.id)).toEqual([
      'main',
      'q3-roadmap-review',
    ]);
  });

  it('takes an explicit id and description, and prints JSON', async () => {
    const dir = await tempDir();
    await initCommand(captureIo(dir));
    const io = captureIo(dir);
    await newBoardCommand(io, 'Ideas', {
      root: dir,
      id: 'ideas-2',
      description: 'Loose',
      json: true,
    });
    expect(JSON.parse(io.out())).toMatchObject({ id: 'ideas-2', name: 'Ideas', nodeCount: 0 });
  });

  it('creates .openboard when it is missing', async () => {
    const dir = await tempDir();
    await newBoardCommand(captureIo(dir), 'First', { root: dir });
    expect(existsSync(path.join(dir, '.openboard/first.board.json'))).toBe(true);
    expect(existsSync(path.join(dir, '.openboard/.local/.gitignore'))).toBe(true);
  });

  it('refuses to overwrite an existing board', async () => {
    const dir = await project();
    const before = await readFile(path.join(dir, '.openboard/main.board.json'), 'utf8');
    await expect(newBoardCommand(captureIo(dir), 'Main', { root: dir })).rejects.toMatchObject({
      code: 'board_exists',
    });
    expect(await readFile(path.join(dir, '.openboard/main.board.json'), 'utf8')).toBe(before);
  });

  it('rejects an invalid id', async () => {
    const dir = await tempDir();
    await expect(
      newBoardCommand(captureIo(dir), 'X', { root: dir, id: '../escape' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
