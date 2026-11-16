import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Board, serializeBoard } from '@openboard-dev/core';
import { describe, expect, it } from 'vitest';
import { run } from '../program.js';
import { captureIo, sampleBoard, tempDir } from '../testing/helpers.js';
import { checkCommand } from './check.js';

const SOURCE = 'export function foo() {\n  return 1;\n}\n';
// The documented link hash: SHA-256 of the linked text, hex, first 32 digits.
const hash = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;

const CONFIG = {
  version: 1,
  policy: { default: 'review_destructive', agents: {} },
  nodeTypes: {
    'x:bug': {
      label: 'Bug',
      fields: [{ key: 'severity', label: 'Severity', kind: 'select', options: ['low', 'high'] }],
    },
  },
};

function linkedBoard(id = 'main'): Board {
  const board = sampleBoard();
  board.id = id;
  const api = board.nodes.n_api;
  if (api) {
    api.links = [
      { kind: 'file', target: 'src/a.ts', line: 1, endLine: 3, hash: hash(SOURCE.slice(0, -1)) },
      { kind: 'file', target: 'src/gone.ts', hash: hash('') },
      { kind: 'url', target: 'https://example.com' },
    ];
  }
  return board;
}

async function project(boards: Board[] = [linkedBoard()]) {
  const dir = await tempDir();
  await mkdir(path.join(dir, '.openboard'));
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src/a.ts'), SOURCE);
  await writeFile(path.join(dir, 'src/gone.ts'), '');
  await writeFile(path.join(dir, '.openboard/config.json'), JSON.stringify(CONFIG));
  for (const board of boards) {
    await writeFile(path.join(dir, `.openboard/${board.id}.board.json`), serializeBoard(board));
  }
  return dir;
}

describe('openboard check', () => {
  it('passes when the boards match the code, and fails once the code changes', async () => {
    const dir = await project();
    const clean = captureIo(dir);
    expect(await checkCommand(clean, undefined, { root: dir })).toBe(0);
    expect(clean.out()).toBe(
      'Board main: the code links match the code, and every node fits its declared type.\n',
    );

    await writeFile(path.join(dir, 'src/a.ts'), SOURCE.replace('return 1;', 'return 2;'));
    const drift = captureIo(dir);
    expect(await checkCommand(drift, undefined, { root: dir })).toBe(1);
    expect(drift.out()).toBe(
      [
        'Board main: 1 node needs a look (1 code link out of date):',
        '  n_api "Build the API" (task)',
        '    #0 file src/a.ts:1-3 [stale]: content changed at lines 1-3',
        'Check those nodes against the code as it is now, then clear the mark with `openboard links refresh <node id>` (with the server running).',
        '',
      ].join('\n'),
    );
    expect(drift.err()).toBe('');
  });

  it('reports missing files and type problems, grouped by board and node', async () => {
    const other = linkedBoard('other');
    other.nodes.n_bug = {
      id: 'n_bug',
      type: 'x:bug',
      title: 'Crash',
      props: { severity: 'urgent' },
      createdBy: 'ada',
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedBy: 'ada',
      updatedAt: '2026-01-02T03:04:05.000Z',
    };
    const dir = await project([linkedBoard(), other]);
    await rm(path.join(dir, 'src/gone.ts'));
    const io = captureIo(dir);
    expect(await checkCommand(io, undefined, { root: dir })).toBe(1);
    const out = io.out();
    expect(out).toContain('Board main: 1 node needs a look (1 code link out of date):');
    expect(out).toContain('    #1 file src/gone.ts [missing]: file missing');
    expect(out).toContain(
      'Board other: 2 nodes need a look (1 code link out of date, 1 type problem):',
    );
    expect(out).toContain('  n_bug "Crash" (x:bug)\n    props.severity');
    expect(out).toContain('or the type in .openboard/config.json.');

    // One board, one check at a time.
    const linksOnly = captureIo(dir);
    expect(await checkCommand(linksOnly, 'other', { root: dir, types: false })).toBe(1);
    expect(linksOnly.out()).not.toContain('n_bug');
    expect(linksOnly.out()).not.toContain('Board main');
    const typesOnly = captureIo(dir);
    expect(await checkCommand(typesOnly, 'main', { root: dir, links: false })).toBe(0);
    expect(typesOnly.out()).toBe('Board main: every node fits its declared type.\n');
  });

  it('prints JSON with only what needs a look', async () => {
    const dir = await project();
    await writeFile(path.join(dir, 'src/a.ts'), `// moved down\n${SOURCE}`);
    const io = captureIo(dir);
    expect(await checkCommand(io, 'main', { root: dir, json: true })).toBe(1);
    const report = JSON.parse(io.out());
    expect(report).toMatchObject({
      clean: false,
      boards: [
        {
          board: 'main',
          links: [{ nodeId: 'n_api', index: 0, state: 'stale' }],
          types: [],
        },
      ],
    });
    expect(report.boards[0].links).toHaveLength(1);
  });

  it('exits 2 on errors', async () => {
    const dir = await project();
    const missing = captureIo(dir);
    expect(await run(['check', 'nope', '--root', dir], missing)).toBe(2);
    expect(missing.err()).toContain('no board "nope"');

    const empty = await tempDir();
    const none = captureIo(empty);
    expect(await run(['check', '--root', empty], none)).toBe(2);
    expect(none.err()).toContain('no boards in');

    const off = captureIo(dir);
    expect(await run(['check', '--root', dir, '--no-links', '--no-types'], off)).toBe(2);
    expect(off.err()).toContain('nothing to check');

    await writeFile(path.join(dir, '.openboard/main.board.json'), '{ not json');
    const broken = captureIo(dir);
    expect(await run(['check', '--root', dir], broken)).toBe(2);
    expect(broken.err()).toContain('does not parse');
  });

  it('parses its switches', async () => {
    const dir = await project();
    await writeFile(path.join(dir, 'src/a.ts'), 'changed');
    const io = captureIo(dir);
    expect(await run(['check', '--root', dir, '--no-links'], io)).toBe(0);
    expect(await run(['check', 'main', '--root', dir], captureIo(dir))).toBe(1);
  });
});
