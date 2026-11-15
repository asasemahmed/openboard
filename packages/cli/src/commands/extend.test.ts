import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBoard, serializeBoard } from '@openboard/core';
import { describe, expect, it, vi } from 'vitest';
import { loadPlugins } from '../lib/plugins.js';
import { startServer } from '../lib/server.js';
import { captureIo, sampleBoard, serverWorks, tempDir } from '../testing/helpers.js';
import { newBoardCommand } from './boards.js';
import { runChecks } from './doctor.js';
import { exportCommand } from './export.js';
import {
  templateAddCommand,
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

describe('template add', () => {
  const templateText = () => {
    const b = sampleBoard();
    b.id = 'shared';
    b.name = 'Shared plan';
    const { comments: _c, ...rest } = b;
    return serializeBoard(rest);
  };
  const templateFile = (dir: string, id: string) =>
    path.join(dir, '.openboard/templates', `${id}.board.json`);
  /** A fetch that answers every URL with this text, and records the URLs. */
  const serve = (text: string) => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(text);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, urls };
  };

  it('adds a template from GitHub, byte for byte, and lists it', async () => {
    const dir = await project();
    const text = templateText();
    const { fetch, urls } = serve(text);
    const io = captureIo(dir);
    await templateAddCommand(io, 'github:ada/boards/templates/shared-plan.board.json@v1', {
      root: dir,
      fetch,
    });
    expect(urls).toEqual([
      'https://raw.githubusercontent.com/ada/boards/v1/templates/shared-plan.board.json',
    ]);
    expect(io.out()).toBe(
      'Added the template shared-plan ("Shared plan", 4 nodes, 2 edges) from github:ada/boards/templates/shared-plan.board.json@v1: .openboard/templates/shared-plan.board.json\n' +
        'Review it, then commit it so everyone gets it.\n',
    );
    expect(await readFile(templateFile(dir, 'shared-plan'), 'utf8')).toBe(text);
    const listed = captureIo(dir);
    await templatesCommand(listed, { root: dir, json: true });
    expect(
      JSON.parse(listed.out()).find((t: { id: string }) => t.id === 'shared-plan'),
    ).toMatchObject({ source: 'project', name: 'Shared plan', nodeCount: 4 });
  });

  it('adds a local file under --name, dry-runs, and replaces only with --force', async () => {
    const dir = await project();
    const source = path.join(dir, 'plan.board.json');
    await writeFile(source, templateText());

    const dry = captureIo(dir);
    await templateAddCommand(dry, 'plan.board.json', {
      root: dir,
      name: 'team-plan',
      dryRun: true,
    });
    expect(dry.out()).toBe(
      'Dry run: plan.board.json is a valid template ("Shared plan", 4 nodes, 2 edges); it would be saved as team-plan: .openboard/templates/team-plan.board.json. Nothing was written.\n',
    );
    await expect(readFile(templateFile(dir, 'team-plan'))).rejects.toThrow(/ENOENT/);

    await templateAddCommand(captureIo(dir), 'plan.board.json', { root: dir, name: 'team-plan' });
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    await expect(
      templateAddCommand(captureIo(dir), 'https://example.com/team-plan.board.json', {
        root: dir,
        fetch,
      }),
    ).rejects.toThrow(
      'a project template "team-plan" exists already (.openboard/templates/team-plan.board.json); pass --force to replace it',
    );
    expect(fetch).not.toHaveBeenCalled();

    const changed = sampleBoard();
    changed.name = 'Changed';
    const { fetch: served } = serve(serializeBoard(changed));
    const forced = captureIo(dir);
    await templateAddCommand(forced, 'https://example.com/team-plan.board.json', {
      root: dir,
      force: true,
      fetch: served,
    });
    expect(forced.out()).toMatch(/^Replaced the template team-plan \("Changed"/);
    expect(parseBoard(await readFile(templateFile(dir, 'team-plan'), 'utf8')).name).toBe('Changed');
  });

  it('refuses invalid templates with the checks project templates get, writing nothing', async () => {
    const dir = await project();
    for (const [text, message] of [
      [
        'not json',
        /^https:\/\/example\.com\/bad\.board\.json does not parse: board file is not valid JSON/,
      ],
      ['{"id":"x"}', /does not parse: board file is invalid: .*; nothing was saved$/],
    ] as const) {
      const { fetch } = serve(text);
      await expect(
        templateAddCommand(captureIo(dir), 'https://example.com/bad.board.json', {
          root: dir,
          fetch,
        }),
      ).rejects.toThrow(message);
    }
    const broken = sampleBoard();
    broken.edges.e_1 = {
      ...(broken.edges.e_1 as NonNullable<typeof broken.edges.e_1>),
      target: 'gone',
    };
    const { fetch } = serve(serializeBoard(broken));
    await expect(
      templateAddCommand(captureIo(dir), 'https://example.com/bad.board.json', {
        root: dir,
        fetch,
      }),
    ).rejects.toThrow(/does not parse: board file is invalid: .*gone/);
    await expect(readFile(templateFile(dir, 'bad'))).rejects.toThrow(/ENOENT/);
  });

  it('never lets the name leave the templates folder', async () => {
    const dir = await project();
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const add = (source: string, name?: string) =>
      templateAddCommand(captureIo(dir), source, {
        root: dir,
        fetch,
        ...(name !== undefined ? { name } : {}),
      });
    await expect(add('https://example.com/t.board.json', '../main')).rejects.toThrow(
      '"../main" cannot be a template name: use lowercase letters, digits and dashes, starting with a letter',
    );
    await expect(add('https://example.com/t.board.json', '/tmp/x')).rejects.toThrow(
      /cannot be a template name/,
    );
    await expect(add('https://example.com/..%2F..%2Fmain.board.json')).rejects.toThrow(
      '"../../main" (from the file name) cannot be a template name; pass --name',
    );
    await expect(add('https://example.com/a%5Cb.board.json')).rejects.toThrow(
      /cannot be a template name/,
    );
    await expect(add('github:ada/boards/../../x.board.json')).rejects.toThrow(/^github:/);
    await expect(add('https://example.com/')).rejects.toThrow(
      '"" (from the file name) cannot be a template name',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses http, and a redirect to http, before writing anything', async () => {
    const dir = await project();
    await expect(
      templateAddCommand(captureIo(dir), 'http://example.com/t.board.json', { root: dir }),
    ).rejects.toThrow('only https:// URLs are allowed');
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://example.com/t.board.json' },
        }),
    ) as unknown as typeof globalThis.fetch;
    await expect(
      templateAddCommand(captureIo(dir), 'https://example.com/t.board.json', { root: dir, fetch }),
    ).rejects.toThrow('redirected to http://example.com/t.board.json; only https:// is allowed');
    await expect(readFile(templateFile(dir, 't'))).rejects.toThrow(/ENOENT/);
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
