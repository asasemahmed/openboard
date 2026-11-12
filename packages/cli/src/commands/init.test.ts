import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseBoard } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { captureIo, tempDir } from '../testing/helpers.js';
import { initCommand } from './init.js';

describe('init', () => {
  it('creates .openboard with an empty main board and an ignored .local', async () => {
    const dir = await tempDir();
    const io = captureIo(dir);
    expect(await initCommand(io)).toBe(0);

    const board = parseBoard(await readFile(path.join(dir, '.openboard/main.board.json'), 'utf8'));
    expect(board.id).toBe('main');
    expect(board.name).toBe(path.basename(dir));
    expect(board.nodes).toEqual({});
    expect(await readFile(path.join(dir, '.openboard/.local/.gitignore'), 'utf8')).toBe('*\n');
    expect(io.out()).toContain('Created .openboard/main.board.json');
  });

  it('uses the current directory, not an enclosing project', async () => {
    const outer = await tempDir();
    await mkdir(path.join(outer, '.openboard'));
    const inner = path.join(outer, 'sub');
    await mkdir(inner);
    await initCommand(captureIo(inner));
    expect(existsSync(path.join(inner, '.openboard/main.board.json'))).toBe(true);
    expect(existsSync(path.join(outer, '.openboard/main.board.json'))).toBe(false);
  });

  it('is idempotent', async () => {
    const dir = await tempDir();
    await initCommand(captureIo(dir));
    const before = await readFile(path.join(dir, '.openboard/main.board.json'), 'utf8');
    const io = captureIo(dir);
    expect(await initCommand(io)).toBe(0);
    expect(io.out()).toBe('Already initialized: .openboard\n');
    expect(await readFile(path.join(dir, '.openboard/main.board.json'), 'utf8')).toBe(before);
  });

  it('never overwrites an existing board', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, '.openboard'));
    const file = path.join(dir, '.openboard/main.board.json');
    await writeFile(file, 'hand-written, even if broken');
    expect(await initCommand(captureIo(dir))).toBe(0);
    expect(await readFile(file, 'utf8')).toBe('hand-written, even if broken');
    expect(existsSync(path.join(dir, '.openboard/.local/.gitignore'))).toBe(true);
  });

  it('does not add main when the project already has other boards', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, '.openboard'));
    await writeFile(path.join(dir, '.openboard/plan.board.json'), '{}');
    await initCommand(captureIo(dir));
    expect(existsSync(path.join(dir, '.openboard/main.board.json'))).toBe(false);
  });

  it('accepts --root', async () => {
    const dir = await tempDir();
    await initCommand(captureIo(dir), { root: 'nested/project' });
    expect(existsSync(path.join(dir, 'nested/project/.openboard/main.board.json'))).toBe(true);
  });
});
