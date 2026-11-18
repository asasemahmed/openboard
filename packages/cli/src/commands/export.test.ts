import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  emptyBoard,
  MAX_MAX_TOKENS,
  parseBoard,
  renderOutline,
  renderRead,
  serializeBoard,
} from '@openboard-dev/core';
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
      'html',
      'outline',
      'text',
    ]);
    expect(exporterForFile('x.json')?.name).toBe('json');
    expect(exporterForFile('x.outline.txt')?.name).toBe('outline');
    expect(exporterForFile('x.txt')?.name).toBe('text');
    expect(exporterForFile('x.pdf')).toBeUndefined();
  });

  it('exports a single frame by id or title, with only its contents and internal edges', async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, '.openboard'));
    const t = '2026-01-01T00:00:00.000Z';
    const by = { createdBy: 'ada', createdAt: t, updatedBy: 'ada', updatedAt: t };
    const board = emptyBoard({ id: 'main', name: 'Main' }, new Date(t));
    board.actors.ada = { id: 'ada', kind: 'human', name: 'Ada' };
    board.nodes = {
      f1: {
        id: 'f1',
        type: 'frame',
        title: 'Risks',
        view: { x: 0, y: 0, width: 400, height: 300 },
        ...by,
      },
      f2: {
        id: 'f2',
        type: 'frame',
        title: 'Tasks',
        view: { x: 500, y: 0, width: 400, height: 300 },
        ...by,
      },
      r1: { id: 'r1', type: 'risk', title: 'Timeout', parent: 'f1', view: { x: 20, y: 40 }, ...by },
      r2: { id: 'r2', type: 'risk', title: 'Retry', parent: 'f1', view: { x: 20, y: 140 }, ...by },
      t1: { id: 't1', type: 'task', title: 'Fix it', parent: 'f2', view: { x: 20, y: 40 }, ...by },
    };
    board.edges = {
      e1: { id: 'e1', type: 'relates_to', source: 'r1', target: 'r2', ...by },
      e2: { id: 'e2', type: 'depends_on', source: 't1', target: 'r1', ...by },
    };
    await writeFile(path.join(dir, '.openboard/main.board.json'), serializeBoard(board));

    const byTitle = captureIo(dir);
    expect(
      await exportCommand(byTitle, 'main', { root: dir, format: 'json', frame: 'risks' }),
    ).toBe(0);
    const parsed = parseBoard(byTitle.out());
    expect(Object.keys(parsed.nodes).sort()).toEqual(['f1', 'r1', 'r2']);
    expect(Object.keys(parsed.edges)).toEqual(['e1']);

    const svgIo = captureIo(dir);
    expect(await exportCommand(svgIo, 'main', { root: dir, format: 'svg', frame: 'f1' })).toBe(0);
    expect(svgIo.out()).toContain('<svg');
    expect(svgIo.out()).toContain('Timeout');
    expect(svgIo.out()).not.toContain('Fix it');

    await expect(
      exportCommand(captureIo(dir), 'main', { root: dir, frame: 'missing' }),
    ).rejects.toThrow(/no frame "missing"/);
  });
});
