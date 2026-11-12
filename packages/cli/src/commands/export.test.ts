import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MAX_MAX_TOKENS, renderOutline, renderRead, serializeBoard } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { EXPORTERS, exporterForFile } from '../exporters.js';
import { captureIo, sampleBoard, tempDir } from '../testing/helpers.js';
import { exportCommand } from './export.js';

async function project() {
  const dir = await tempDir();
  await mkdir(path.join(dir, '.openboard'));
  const board = sampleBoard();
  await writeFile(path.join(dir, '.openboard/main.board.json'), serializeBoard(board));
  return { dir, board };
}

describe('export', () => {
  it('json is the deterministic board file', async () => {
    const { dir, board } = await project();
    const io = captureIo(dir);
    expect(await exportCommand(io, 'main', { root: dir, format: 'json' })).toBe(0);
    expect(io.out()).toBe(serializeBoard(board));
  });

  it('outline is the full outline text', async () => {
    const { dir, board } = await project();
    const io = captureIo(dir);
    await exportCommand(io, undefined, { root: dir, format: 'outline' });
    const expected = renderOutline(board, 0, { maxTokens: MAX_MAX_TOKENS }).text;
    expect(io.out()).toBe(`${expected}\n`);
    expect(io.out()).toContain('Plan');
  });

  it('text is a full read of every node', async () => {
    const { dir, board } = await project();
    const io = captureIo(dir);
    await exportCommand(io, 'main', { root: dir, format: 'text' });
    const expected = renderRead(board, Object.values(board.nodes), 0, {
      detail: 'full',
      maxTokens: MAX_MAX_TOKENS,
    }).text;
    expect(io.out()).toBe(`${expected}\n`);
    for (const title of ['Build the API', 'Write docs', 'Scope creep', 'Routes and errors.']) {
      expect(io.out()).toContain(title);
    }
  });

  it('writes to --out and guesses the format from the extension', async () => {
    const { dir, board } = await project();
    const io = captureIo(dir);
    await exportCommand(io, 'main', { root: dir, out: 'board.outline.txt' });
    expect(io.out()).toBe('');
    expect(io.err()).toBe('Wrote board.outline.txt\n');
    expect(await readFile(path.join(dir, 'board.outline.txt'), 'utf8')).toBe(
      `${renderOutline(board, 0, { maxTokens: MAX_MAX_TOKENS }).text}\n`,
    );
  });

  it('defaults to json', async () => {
    const { dir, board } = await project();
    const io = captureIo(dir);
    await exportCommand(io, undefined, { root: dir });
    expect(io.out()).toBe(serializeBoard(board));
  });

  it('fails clearly for a missing board', async () => {
    const { dir } = await project();
    await expect(exportCommand(captureIo(dir), 'nope', { root: dir })).rejects.toThrow(
      /no board "nope"/,
    );
  });

  it('keeps a registry with one entry per format', () => {
    expect(EXPORTERS.map((e) => e.name)).toEqual([
      'json',
      'markdown',
      'mermaid',
      'canvas',
      'svg',
      'outline',
      'text',
    ]);
    expect(exporterForFile('x.json')?.name).toBe('json');
    expect(exporterForFile('x.outline.txt')?.name).toBe('outline');
    expect(exporterForFile('x.txt')?.name).toBe('text');
    expect(exporterForFile('x.pdf')).toBeUndefined();
  });
});
