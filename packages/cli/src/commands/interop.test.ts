import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type Actor, parseBoard, serializeBoard } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { EXPORTERS, exporterForFile, findExporter } from '../exporters.js';
import { startServer } from '../lib/server.js';
import { captureIo, sampleBoard, serverWorks, tempDir } from '../testing/helpers.js';
import { exportCommand } from './export.js';
import { importCommand, intoFrame } from './import.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };

const MERMAID = `flowchart TD
  subgraph api [HTTP API]
    router[Router] --> auth[Session auth]
  end
  auth --> db[(Orders DB)]
`;

const CANVAS = JSON.stringify({
  nodes: [
    { id: 'g1', type: 'group', x: 0, y: 0, width: 600, height: 400, label: 'Ideas' },
    { id: 'a', type: 'text', x: 40, y: 60, width: 240, height: 80, text: 'First idea' },
    { id: 'b', type: 'text', x: 320, y: 60, width: 240, height: 80, text: 'Second idea' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', label: 'leads to' }],
});

async function project() {
  const dir = await tempDir();
  await mkdir(path.join(dir, '.openboard'));
  await writeFile(path.join(dir, '.openboard/main.board.json'), serializeBoard(sampleBoard()));
  return dir;
}

const boardFile = (dir: string) => path.join(dir, '.openboard/main.board.json');

describe('export formats', () => {
  it('offers core formats and the two text formats, by name, alias and extension', () => {
    expect(EXPORTERS.map((e) => e.name)).toEqual([
      'json',
      'markdown',
      'mermaid',
      'canvas',
      'svg',
      'outline',
      'text',
    ]);
    expect(findExporter('md')?.name).toBe('markdown');
    expect(findExporter('jsoncanvas')?.name).toBe('canvas');
    expect(exporterForFile('board.canvas')?.name).toBe('canvas');
    expect(exporterForFile('notes.markdown')?.name).toBe('markdown');
    expect(exporterForFile('flow.mmd')?.name).toBe('mermaid');
    expect(exporterForFile('x.outline.txt')?.name).toBe('outline');
  });

  it('writes every format from the board file', async () => {
    const dir = await project();
    const run = async (format: string, extra: Record<string, unknown> = {}) => {
      const io = captureIo(dir);
      expect(await exportCommand(io, undefined, { root: dir, format, ...extra })).toBe(0);
      return io.out();
    };
    expect(await run('markdown')).toContain('Build the API');
    expect(await run('md')).toContain('Build the API');
    expect(await run('mermaid')).toMatch(/^flowchart TD$/m);
    expect(JSON.parse(await run('canvas')).nodes.length).toBeGreaterThan(0);
    const light = await run('svg');
    expect(light).toMatch(/^(<\?xml[^>]*>\s*)?<svg\b/);
    expect(light.trimEnd()).toMatch(/<\/svg>$/);
    expect(await run('svg', { theme: 'dark' })).not.toBe(light);
  });

  it('picks the format from --out', async () => {
    const dir = await project();
    const io = captureIo(dir);
    await exportCommand(io, 'main', { root: dir, out: 'plan.mmd' });
    expect(await readFile(path.join(dir, 'plan.mmd'), 'utf8')).toMatch(/^flowchart TD$/m);
    expect(io.err()).toBe('Wrote plan.mmd\n');
  });
});

describe('import without a server', () => {
  it('adds a Mermaid flowchart to the board file, into a frame', async () => {
    const dir = await project();
    await writeFile(path.join(dir, 'flow.mmd'), MERMAID);
    const io = captureIo(dir);
    expect(await importCommand(io, 'flow.mmd', undefined, { root: dir, frame: 'f_plan' })).toBe(0);
    expect(io.out()).toMatch(/^Imported flow\.mmd into main: added \d+ nodes, \d+ edges\.\n/);
    expect(io.out()).toContain('no position yet');
    const board = parseBoard(await readFile(boardFile(dir), 'utf8'));
    const router = Object.values(board.nodes).find((n) => n.title === 'Router');
    const frame = Object.values(board.nodes).find((n) => n.title === 'HTTP API');
    expect(frame?.parent).toBe('f_plan');
    expect(router?.parent).toBe(frame?.id);
    expect(Object.values(board.nodes).find((n) => n.title === 'Orders DB')?.parent).toBe('f_plan');
    expect(board.actors.cli?.kind).toBe('human');
  });

  it('keeps JSON Canvas positions, reads stdin, and changes nothing in a dry run', async () => {
    const dir = await project();
    const before = await readFile(boardFile(dir), 'utf8');
    const dry = captureIo(dir);
    await importCommand(dry, '-', undefined, {
      root: dir,
      format: 'canvas',
      dryRun: true,
      stdin: Readable.from([CANVAS]),
    });
    expect(dry.out()).toMatch(
      /^Dry run: importing - into main would add 3 nodes, 1 edge\. Nothing was changed\.\n$/,
    );
    expect(await readFile(boardFile(dir), 'utf8')).toBe(before);

    const io = captureIo(dir);
    await importCommand(io, '-', undefined, { root: dir, stdin: Readable.from([CANVAS]) });
    const board = parseBoard(await readFile(boardFile(dir), 'utf8'));
    const first = Object.values(board.nodes).find((n) => n.title === 'First idea');
    expect(first?.view?.x).toBeTypeOf('number');
    expect(io.out()).not.toContain('no position yet');
  });

  it('creates a board with --new, and explains what it cannot read', async () => {
    const dir = await project();
    await writeFile(path.join(dir, 'ideas.canvas'), CANVAS);
    const io = captureIo(dir);
    await importCommand(io, 'ideas.canvas', undefined, { root: dir, new: 'Ideas' });
    expect(io.out()).toContain('Created board ideas');
    expect(io.out()).toContain('Imported ideas.canvas into ideas');

    await writeFile(path.join(dir, 'notes.txt'), 'just some text');
    await expect(
      importCommand(captureIo(dir), 'notes.txt', undefined, { root: dir }),
    ).rejects.toThrow(
      'cannot tell the format of notes.txt; pass --format mermaid or --format canvas',
    );
    await expect(
      importCommand(captureIo(dir), 'ideas.canvas', 'main', { root: dir, new: 'X' }),
    ).rejects.toThrow('not both');
    await expect(
      importCommand(captureIo(dir), 'ideas.canvas', undefined, { root: dir, frame: 'n_api' }),
    ).rejects.toThrow(
      /the import was refused; nothing was changed:\n {2}ops\[\d+\]: .*not a frame/,
    );
  });

  it('passes warnings on to stderr', async () => {
    const dir = await project();
    const io = captureIo(dir);
    await importCommand(io, '-', undefined, {
      root: dir,
      format: 'mermaid',
      stdin: Readable.from(['flowchart TD\n  a[A] --> b[B]\n  click a callback\n']),
    });
    expect(io.err()).toMatch(/^warning: /m);
  });

  it('re-parents only what has no frame', () => {
    const ops = intoFrame(
      [
        { op: 'add_node', ref: 'f', node: { type: 'frame', title: 'F' } },
        { op: 'add_node', node: { type: 'note', title: 'In F', parent: '$f' } },
        { op: 'add_edge', edge: { type: 'relates_to', source: '$f', target: 'n_x' } },
      ],
      'f_top',
    );
    expect(ops.map((op) => (op.op === 'add_node' ? op.node.parent : undefined))).toEqual([
      'f_top',
      '$f',
      undefined,
    ]);
  });
});

describe.skipIf(!serverWorks)('import with a running server', () => {
  it('applies through the server as the person at the terminal, with a reason', async () => {
    const dir = await project();
    const server = await startServer({ root: dir, port: 0 });
    try {
      const io = captureIo(dir);
      await writeFile(path.join(dir, 'flow.mmd'), MERMAID);
      await importCommand(io, 'flow.mmd', 'main', { root: dir });
      expect(io.out()).toMatch(/^Imported flow\.mmd into main: added \d+ nodes, \d+ edges\.\n$/);
      const ada = server.api(ADA);
      const { batches } = await ada.history('main', { limit: 1 });
      expect(batches[0]).toMatchObject({ actor: 'cli', reason: 'Import from Mermaid' });
      const board = await ada.getBoard('main');
      expect(Object.values(board.nodes).every((n) => n.view !== undefined)).toBe(true);

      const exported = captureIo(dir);
      await exportCommand(exported, 'main', { root: dir, format: 'mermaid' });
      expect(exported.out()).toContain('Router');

      const dry = captureIo(dir);
      await importCommand(dry, 'flow.mmd', 'main', { root: dir, dryRun: true });
      expect(dry.out()).toContain('Dry run: importing flow.mmd into main would add');
    } finally {
      await server.close();
    }
  });
});
