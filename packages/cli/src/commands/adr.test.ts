import { lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serializeBoard } from '@openboard-dev/core';
import { describe, expect, it } from 'vitest';
import { captureIo, sampleBoard, tempDir } from '../testing/helpers.js';
import { adrCommand } from './adr.js';

const T = '2026-01-02T03:04:05.000Z';

async function project() {
  const dir = await tempDir();
  await mkdir(path.join(dir, '.openboard'));
  const board = sampleBoard();
  const by = { createdBy: 'ada', createdAt: T, updatedBy: 'ada', updatedAt: T };
  board.nodes.d_pg = {
    id: 'd_pg',
    type: 'decision',
    title: 'Use Postgres',
    status: 'done',
    body: 'Orders need transactions.',
    ...by,
  };
  board.edges.e_3 = { id: 'e_3', type: 'implements', source: 'n_api', target: 'd_pg', ...by };
  await writeFile(path.join(dir, '.openboard/main.board.json'), serializeBoard(board));
  return { dir, board };
}

describe('adr', () => {
  it('writes one file per decision to docs/adr, and a rerun changes nothing', async () => {
    const { dir } = await project();
    const io = captureIo(dir);
    expect(await adrCommand(io, undefined, { root: dir })).toBe(0);
    expect(io.out()).toBe(
      'new        docs/adr/0001-use-postgres.md\nWrote 1 file to docs/adr (1 new, 0 updated, 0 unchanged).\n',
    );
    const text = await readFile(path.join(dir, 'docs/adr/0001-use-postgres.md'), 'utf8');
    expect(text).toContain('# 1. Use Postgres\n\n<!-- openboard-adr board=main node=d_pg -->');
    expect(text).toContain('## Status\n\nAccepted\n');
    expect(text).toContain('- Implemented by task: Build the API (in progress)');

    const again = captureIo(dir);
    await adrCommand(again, 'main', { root: dir });
    expect(again.out()).toBe(
      'unchanged  docs/adr/0001-use-postgres.md\nWrote 0 files to docs/adr (0 new, 0 updated, 1 unchanged).\n',
    );
  });

  it('writes nothing with --dry-run', async () => {
    const { dir } = await project();
    const io = captureIo(dir);
    await adrCommand(io, undefined, { root: dir, out: 'decisions', dryRun: true });
    expect(io.out()).toBe(
      'new        decisions/0001-use-postgres.md\nDry run: 1 new, 0 updated, 0 unchanged. Nothing was written.\n',
    );
    await expect(readdir(path.join(dir, 'decisions'))).rejects.toThrow(/ENOENT/);
  });

  it('numbers after the files in the folder and replaces a link instead of following it', async () => {
    const { dir } = await project();
    const adr = path.join(dir, 'docs/adr');
    await mkdir(adr, { recursive: true });
    await writeFile(path.join(adr, '0004-older.md'), '# 4. Older\n');
    const outside = path.join(dir, 'outside.md');
    await writeFile(outside, 'keep me <!-- openboard-adr board=main node=d_pg -->\n');
    await symlink(outside, path.join(adr, '0005-link.md'));
    const io = captureIo(dir);
    await adrCommand(io, undefined, { root: dir });
    expect(io.out()).toContain('new        docs/adr/0006-use-postgres.md');
    expect(await readFile(outside, 'utf8')).toBe(
      'keep me <!-- openboard-adr board=main node=d_pg -->\n',
    );
    expect((await lstat(path.join(adr, '0005-link.md'))).isSymbolicLink()).toBe(true);
    expect((await readdir(adr)).sort()).toEqual([
      '0004-older.md',
      '0005-link.md',
      '0006-use-postgres.md',
    ]);
  });

  it('says so when the board has no decisions', async () => {
    const { dir } = await project();
    const board = sampleBoard();
    await writeFile(path.join(dir, '.openboard/main.board.json'), serializeBoard(board));
    const io = captureIo(dir);
    await adrCommand(io, undefined, { root: dir });
    expect(io.out()).toBe('No decision cards on board main.\n');
  });
});
