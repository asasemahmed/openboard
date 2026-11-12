import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBoard, serializeBoard } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { loadPlugins } from '../lib/plugins.js';
import { startServer } from '../lib/server.js';
import { captureIo, sampleBoard, serverWorks, tempDir } from '../testing/helpers.js';
import { newBoardCommand } from './boards.js';
import { runChecks } from './doctor.js';
import { exportCommand } from './export.js';
import {
  templateApplyCommand,
  templateSaveCommand,
  templatesCommand,
  typesCheckCommand,
  typesCommand,
} from './extend.js';
import { startCommand } from './start.js';

const EXAMPLE = fileURLToPath(
  new URL('../../../../examples/plugin-estimates/index.js', import.meta.url),
);

const CONFIG = {
  version: 1,
  policy: { default: 'review_destructive', agents: {} },
  nodeTypes: {
    'x:bug': {
      label: 'Bug',
      color: 'red',
      icon: 'bug',
      fields: [
        {
          key: 'severity',
          label: 'Severity',
          kind: 'select',
          options: ['low', 'high'],
          required: true,
        },
      ],
    },
  },
};

async function project(config?: unknown) {
  const dir = await tempDir();
  await mkdir(path.join(dir, '.openboard'));
  await writeFile(path.join(dir, '.openboard/main.board.json'), serializeBoard(sampleBoard()));
  if (config) await writeFile(path.join(dir, '.openboard/config.json'), JSON.stringify(config));
  return dir;
}

const board = async (dir: string, id = 'main') =>
  parseBoard(await readFile(path.join(dir, `.openboard/${id}.board.json`), 'utf8'));

describe('templates without a server', () => {
  it("lists the built-in templates and the project's, and creates a board from one", async () => {
    const dir = await project();
    const list = captureIo(dir);
    await templatesCommand(list, { root: dir });
    expect(list.out()).toMatch(/^8 templates\. Apply one with: openboard template apply <id>/);
    expect(list.out()).toContain('feature-plan "Feature plan" (built-in;');

    const created = captureIo(dir);
    await newBoardCommand(created, 'CSV export', { root: dir, template: 'feature-plan' });
    expect(created.out()).toBe('Created board csv-export from the template feature-plan\n');
    const made = await board(dir, 'csv-export');
    expect(
      Object.values(made.nodes).some((n) => n.type === 'frame' && n.title === 'CSV export'),
    ).toBe(true);
  });

  it('applies a template into a frame, dry-runs, and saves a board as a project template', async () => {
    const dir = await project();
    const before = Object.keys((await board(dir)).nodes).length;
    const dry = captureIo(dir);
    await templateApplyCommand(dry, 'kanban', undefined, { root: dir, dryRun: true });
    expect(dry.out()).toMatch(
      /^Dry run: template kanban on main would add \d+ nodes, \d+ edges?\. Nothing was changed\.\n$/,
    );
    expect(Object.keys((await board(dir)).nodes)).toHaveLength(before);

    const io = captureIo(dir);
    await templateApplyCommand(io, 'decision-record', 'main', {
      root: dir,
      frame: 'f_plan',
      title: 'Pick a queue',
    });
    expect(io.out()).toMatch(/^Applied template decision-record to main: added \d+ nodes/);
    const after = await board(dir);
    const outer = Object.values(after.nodes).find((n) => n.title === 'Pick a queue');
    expect(outer?.parent).toBe('f_plan');

    const saved = captureIo(dir);
    await templateSaveCommand(saved, 'launch-plan', undefined, { root: dir });
    expect(saved.out()).toContain(
      'Saved board main as the template launch-plan: .openboard/templates/launch-plan.board.json',
    );
    const listed = captureIo(dir);
    await templatesCommand(listed, { root: dir, json: true });
    expect(
      JSON.parse(listed.out()).find((t: { id: string }) => t.id === 'launch-plan'),
    ).toMatchObject({
      source: 'project',
      name: 'Launch',
    });
    await expect(
      templateSaveCommand(captureIo(dir), 'launch-plan', undefined, { root: dir }),
    ).rejects.toThrow(/exists already .* pass --force/);
    await expect(
      templateSaveCommand(captureIo(dir), 'Launch Plan', undefined, { root: dir }),
    ).rejects.toThrow(/cannot be a template name/);
    await expect(
      templateApplyCommand(captureIo(dir), 'nope', undefined, { root: dir }),
    ).rejects.toThrow(/no template "nope"/);

    const fromSaved = captureIo(dir);
    await newBoardCommand(fromSaved, 'Copy', { root: dir, template: 'launch-plan' });
    expect(Object.keys((await board(dir, 'copy')).nodes).length).toBe(
      Object.keys(after.nodes).length,
    );
  });
});

describe('types without a server', () => {
  it('prints the schema with declared types and checks a board against them', async () => {
    const dir = await project(CONFIG);
    const io = captureIo(dir);
    await typesCommand(io, { root: dir });
    expect(io.out()).toContain('Node types (built-in):');
    expect(io.out()).toContain('x:bug');
    const json = captureIo(dir);
    await typesCommand(json, { root: dir, json: true });
    expect(
      JSON.parse(json.out()).nodeTypes.find((t: { type: string }) => t.type === 'x:bug'),
    ).toMatchObject({
      label: 'Bug',
      source: 'project',
    });

    const clean = captureIo(dir);
    expect(await typesCheckCommand(clean, undefined, { root: dir })).toBe(0);
    expect(clean.out()).toBe('Board main: every node fits its declared type.\n');

    const b = sampleBoard();
    const T = '2026-01-02T03:04:05.000Z';
    b.nodes.n_bug = {
      id: 'n_bug',
      type: 'x:bug',
      title: 'Crash',
      createdBy: 'ada',
      createdAt: T,
      updatedBy: 'ada',
      updatedAt: T,
    };
    await writeFile(path.join(dir, '.openboard/main.board.json'), serializeBoard(b));
    const problems = captureIo(dir);
    expect(await typesCheckCommand(problems, 'main', { root: dir })).toBe(1);
    expect(problems.out()).toContain('n_bug (x:bug):');
    expect(problems.out()).toContain('severity');
  });
});

describe('plugins', () => {
  it('loads a plugin module by path: a default export, or a function that makes one', async () => {
    const [estimates] = await loadPlugins([EXAMPLE], process.cwd());
    expect(estimates?.name).toBe('estimates');
    const dir = await tempDir();
    await writeFile(
      path.join(dir, 'factory.mjs'),
      "export function plugin() { return { name: 'made' }; }\n",
    );
    await writeFile(path.join(dir, 'empty.mjs'), 'export const x = 1;\n');
    expect((await loadPlugins(['./factory.mjs'], dir))[0]?.name).toBe('made');
    await expect(loadPlugins(['./empty.mjs'], dir)).rejects.toThrow(/exports no plugin/);
    await expect(loadPlugins(['./missing.mjs'], dir)).rejects.toThrow(/no such file/);
    await expect(loadPlugins(['not-a-real-openboard-plugin'], dir)).rejects.toThrow(
      /no such package/,
    );
  });

  it.skipIf(!serverWorks)(
    "serves a plugin's template and export format, and doctor lists it",
    async () => {
      const dir = await project();
      const server = await startServer({
        root: dir,
        port: 0,
        plugins: await loadPlugins([EXAMPLE], dir),
      });
      try {
        const list = captureIo(dir);
        await templatesCommand(list, { root: dir });
        expect(list.out()).toContain('estimation "Estimation" (plugin estimates;');
        await templateApplyCommand(captureIo(dir), 'estimation', undefined, { root: dir });
        const csv = captureIo(dir);
        await exportCommand(csv, 'main', { root: dir, format: 'csv' });
        expect(csv.out()).toMatch(/^id,title,status,points,confidence,owner,due\r\n/);
        const types = captureIo(dir);
        await typesCommand(types, { root: dir });
        expect(types.out()).toContain('x:estimate');
        const checks = await runChecks(captureIo(dir), { root: dir, app: { dir, built: true } });
        expect(checks.find((c) => c.label.startsWith('Plugin estimates'))?.label).toBe(
          'Plugin estimates 1.0.0 is loaded',
        );
      } finally {
        await server.close();
      }
      await expect(
        exportCommand(captureIo(dir), 'main', { root: dir, format: 'csv' }),
      ).rejects.toThrow(/a plugin's format needs the server that loads it running/);
    },
  );

  it.skipIf(!serverWorks)('start --plugin prints what it loaded', async () => {
    const dir = await project();
    let stop: (signal: string) => void = () => {};
    const io = captureIo(dir);
    io.shutdown = () => new Promise<string>((resolve) => (stop = resolve));
    let ready: () => void = () => {};
    const up = new Promise<void>((resolve) => (ready = resolve));
    const done = startCommand(io, {
      root: dir,
      port: 0,
      open: false,
      plugins: [EXAMPLE],
      onReady: () => ready(),
    });
    await Promise.race([up, done]);
    expect(io.out()).toContain('Plugin: estimates 1.0.0');
    stop('SIGTERM');
    await done;
  });
});
