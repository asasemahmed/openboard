import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Actor,
  BUILTIN_TEMPLATES,
  DEFAULT_CONFIG,
  type NodeTypeDef,
  type OpenBoardPlugin,
  type ProjectConfig,
} from '@openboard/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The example plugin is a plain ES module outside the package; it is used end to end here.
import { createEstimatesPlugin } from '../../../examples/plugin-estimates/index.js';
import { findOverlaps } from './layout/index.js';
import {
  api,
  type RawResponse,
  rawRequest,
  removeRoot,
  sleep,
  startTestServer,
  tempRoot,
  waitFor,
} from './testing.js';
import type { OpenBoardServer, ServerOptions } from './types.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const BOT: Actor = { id: 'bot', kind: 'agent', name: 'Bot' };
const ADA_HEADERS = { 'x-openboard-actor-id': 'ada', 'x-openboard-actor-kind': 'human' };
const BOT_HEADERS = { 'x-openboard-actor-id': 'bot', 'x-openboard-actor-kind': 'agent' };

const BUG: NodeTypeDef = {
  label: 'Bug',
  description: 'A defect someone found.',
  color: 'red',
  icon: 'bug',
  fields: [
    {
      key: 'severity',
      label: 'Severity',
      kind: 'select',
      options: ['low', 'medium', 'high'],
      required: true,
    },
    { key: 'found', label: 'Found on', kind: 'date' },
  ],
};

const withBug = (nodeTypes: Record<string, NodeTypeDef> = { 'x:bug': BUG }): ProjectConfig => ({
  ...DEFAULT_CONFIG,
  nodeTypes,
});

let root: string;
let servers: OpenBoardServer[] = [];
let lines: string[] = [];

async function start(options: Omit<ServerOptions, 'root'> = {}, at = root) {
  const server = await startTestServer(at, { log: (line) => lines.push(line), ...options });
  servers.push(server);
  return server;
}

beforeEach(async () => {
  root = await tempRoot();
  lines = [];
});

afterEach(async () => {
  for (const server of servers) await server.close();
  servers = [];
  await removeRoot(root);
});

const addBug = (props: Record<string, unknown>) => ({
  op: 'add_node',
  ref: 'b',
  node: { type: 'x:bug', title: 'Login fails', props },
});

describe('declared types', () => {
  it('are set through PUT /api/config by people only, and saved deterministically', async () => {
    const s = await start();
    const bot = await api(s, 'PUT', '/api/config', withBug(), BOT_HEADERS);
    expect(bot.status).toBe(403);
    const bad = await api(
      s,
      'PUT',
      '/api/config',
      withBug({ 'x:bug': { ...BUG, color: 'mauve' as never } }),
      ADA_HEADERS,
    );
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain('nodeTypes');
    const res = await api(s, 'PUT', '/api/config', withBug(), ADA_HEADERS);
    expect(res.status).toBe(200);
    expect(res.json.nodeTypes['x:bug'].label).toBe('Bug');
    const file = await readFile(path.join(root, '.openboard', 'config.json'), 'utf8');
    expect(file).toContain('"nodeTypes"');
    expect((await api(s, 'GET', '/api/config')).json.nodeTypes['x:bug'].fields).toHaveLength(2);
  });

  it('check applies: a valid node lands, an invalid one is refused by index', async () => {
    const s = await start();
    await s.api(ADA).setConfig(withBug());
    await s.api(ADA).createBoard({ name: 'Plan' });
    const good = await api(
      s,
      'POST',
      '/api/boards/plan/apply',
      { ops: [addBug({ severity: 'high', found: '2026-11-12' })] },
      BOT_HEADERS,
    );
    expect(good.json.status).toBe('applied');
    const bad = await api(
      s,
      'POST',
      '/api/boards/plan/apply',
      {
        ops: [
          { op: 'add_node', node: { type: 'note', title: 'fine' } },
          addBug({ severity: 'urgent' }),
          { op: 'add_node', node: { type: 'x:other', title: 'undeclared', props: { a: 1 } } },
        ],
      },
      BOT_HEADERS,
    );
    expect(bad.json.status).toBe('invalid');
    expect(bad.json.errors).toEqual([
      {
        index: 1,
        code: 'invalid',
        message: 'props.severity must be one of low, medium, high (got "urgent") for x:bug nodes',
      },
    ]);
    expect(Object.keys((await s.api(ADA).getBoard('plan')).nodes)).toHaveLength(1);
  });

  it('are described by GET /api/schema, and shown in reads and the outline', async () => {
    const s = await start();
    await s.api(ADA).setConfig(withBug());
    await s.api(ADA).createBoard({ name: 'Plan' });
    await s.api(BOT).apply('plan', { ops: [addBug({ severity: 'low' })] as never });
    const schema = await api(s, 'GET', '/api/schema?maxTokens=3000');
    expect(schema.status).toBe(200);
    expect(schema.json.nodeTypes.map((t: { type: string }) => t.type)).toContain('x:bug');
    expect(schema.json.text).toContain('props.severity "Severity": select low|medium|high');
    expect(schema.json.truncated).toBe(false);
    const read = await s.api(BOT).read('plan');
    expect(read.text).toContain('fields: Severity "low"');
    const outline = await s.api(BOT).outline('plan');
    expect(outline.text).toContain('Custom types: x:bug - see the schema.');
  });

  it('do not refuse older nodes for fields a batch leaves alone, and list them', async () => {
    const s = await start();
    await s.api(ADA).setConfig(withBug({ 'x:bug': { label: 'Bug' } }));
    await s.api(ADA).createBoard({ name: 'Plan' });
    await s.api(BOT).apply('plan', {
      ops: [{ op: 'add_node', id: 'n_old', node: { type: 'x:bug', title: 'Old' } }],
    });
    await s.api(ADA).setConfig(withBug());
    const renamed = await s.api(BOT).apply('plan', {
      ops: [{ op: 'update_node', id: 'n_old', patch: { title: 'Older' } }],
    });
    expect(renamed.status).toBe('applied');
    const touched = await s.api(BOT).apply('plan', {
      ops: [{ op: 'update_node', id: 'n_old', patch: { props: { severity: 'none' } } }],
    });
    expect(touched.status).toBe('invalid');
    const schema = await s.api(BOT).schema({ board: 'plan' });
    expect(schema.warnings).toEqual([
      { nodeId: 'n_old', type: 'x:bug', message: expect.stringContaining('severity is required') },
    ]);
    expect(schema.text).toContain('n_old: props.severity is required');
    expect((await s.api(BOT).outline('plan')).text).toContain('1 problem on this board');
  });
});

describe('templates', () => {
  it('lists the built-in templates with their counts', async () => {
    const s = await start();
    const res = await api(s, 'GET', '/api/templates');
    expect(res.status).toBe(200);
    expect(res.json.templates.map((t: { id: string }) => t.id)).toEqual(
      BUILTIN_TEMPLATES.map((t) => t.id),
    );
    for (const t of res.json.templates) {
      expect(t.source).toBe('builtin');
      expect(t.nodeCount).toBeGreaterThan(0);
    }
    expect(res.json.text).toContain('8 templates.');
  });

  for (const template of BUILTIN_TEMPLATES) {
    it(`starts a board from ${template.id}: laid out without overlaps, one batch`, async () => {
      const s = await start();
      const summary = await s.api(BOT).createBoard({ name: 'Start', template: template.id });
      expect(summary.nodeCount).toBe(template.build().filter((o) => o.op === 'add_node').length);
      const board = await s.api(BOT).getBoard('start');
      for (const node of Object.values(board.nodes)) {
        expect(node.view, node.title).toBeDefined();
        expect(node.createdBy).toBe('bot');
      }
      expect(findOverlaps(board)).toEqual([]);
      const outer = Object.values(board.nodes).find((n) => n.parent === undefined);
      expect(outer?.title).toBe('Start');
      const history = await s.api(BOT).history('start');
      expect(history.batches).toHaveLength(1);
      expect(history.batches[0]?.reason).toBe(`Template: ${template.name}`);
      const outline = await s.api(BOT).outline('start');
      expect(outline.text).toContain('[frame]');
    });
  }

  it('applies through POST /api/boards/:id/template, dry runs, and into a frame', async () => {
    const s = await start();
    await s.api(ADA).createBoard({ name: 'Plan' });
    const frame = await s.api(ADA).apply('plan', {
      ops: [
        { op: 'add_node', ref: 'f', node: { type: 'frame', title: 'Q4' } },
        { op: 'add_node', node: { type: 'note', title: 'Already here', parent: '$f' } },
      ],
    });
    const frameId = frame.refs.f as string;
    const dry = await api(
      s,
      'POST',
      '/api/boards/plan/template',
      { template: 'kanban', dryRun: true },
      ADA_HEADERS,
    );
    expect(dry.json.status).toBe('valid');
    expect(Object.keys((await s.api(ADA).getBoard('plan')).nodes)).toHaveLength(2);

    const res = await api(
      s,
      'POST',
      '/api/boards/plan/template',
      { template: 'kanban', frame: frameId, title: 'Team board' },
      ADA_HEADERS,
    );
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('applied');
    const board = await s.api(ADA).getBoard('plan');
    const outer = board.nodes[res.json.refs.board];
    expect(outer).toMatchObject({ title: 'Team board', parent: frameId });
    expect(findOverlaps(board)).toEqual([]);

    const missing = await api(
      s,
      'POST',
      '/api/boards/plan/template',
      { template: 'nope' },
      ADA_HEADERS,
    );
    expect(missing.status).toBe(404);
    expect(missing.json.error.message).toContain('feature-plan');
    const notFrame = await s.api(ADA).apply('plan', {
      ops: [{ op: 'add_node', ref: 'n', node: { type: 'note', title: 'n' } }],
    });
    await expect(
      s.api(ADA).applyTemplate('plan', { template: 'kanban', frame: notFrame.refs.n as string }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('follow the review policy for agents', async () => {
    const s = await start();
    await s.api(ADA).createBoard({ name: 'Plan' });
    expect((await s.api(BOT).applyTemplate('plan', { template: 'feature-plan' })).status).toBe(
      'applied',
    );
    await s.api(ADA).setConfig({ version: 1, policy: { default: 'review_all', agents: {} } });
    const proposed = await s.api(BOT).applyTemplate('plan', { template: 'kanban' });
    expect(proposed.status).toBe('proposed');
    await s.api(ADA).setConfig({ version: 1, policy: { default: 'locked', agents: {} } });
    const locked = await s.api(BOT).applyTemplate('plan', { template: 'kanban' });
    expect(locked.status).toBe('invalid');
    expect(locked.errors?.[0]?.code).toBe('forbidden');
  });

  it('refuses a board from an unknown template without creating it', async () => {
    const s = await start();
    const res = await api(
      s,
      'POST',
      '/api/boards',
      { name: 'Plan', template: 'nope' },
      ADA_HEADERS,
    );
    expect(res.status).toBe(404);
    expect(await s.api(ADA).listBoards()).toEqual([]);
  });

  it('reads project templates from .openboard/templates, with fresh ids and no comments', async () => {
    const s = await start();
    await s.api(BOT).createBoard({ name: 'Weekly', description: 'A weekly review.' });
    const made = await s.api(BOT).apply('weekly', {
      ops: [
        { op: 'add_node', ref: 'f', node: { type: 'frame', title: 'This week' } },
        { op: 'add_node', ref: 't', node: { type: 'task', title: 'Review', parent: '$f' } },
        { op: 'add_node', ref: 'n', node: { type: 'note', title: 'Notes' } },
        { op: 'add_edge', edge: { type: 'relates_to', source: '$n', target: '$t' } },
      ],
    });
    await s.api(BOT).comment('weekly', { body: 'Not part of it', nodeId: made.refs.t as string });
    // Closing writes the board file; it is then copied in as a template.
    await s.close();
    servers = [];
    const dir = path.join(root, '.openboard', 'templates');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'weekly.board.json'),
      await readFile(path.join(root, '.openboard', 'weekly.board.json'), 'utf8'),
    );
    await writeFile(path.join(dir, 'broken.board.json'), '{ not json');

    const s2 = await start();
    const listed = (await s2.api(ADA).templates()).templates.find((t) => t.id === 'weekly');
    expect(listed).toMatchObject({
      name: 'Weekly',
      description: 'A weekly review.',
      source: 'project',
      nodeCount: 3,
      edgeCount: 1,
    });
    expect((await s2.api(ADA).templates()).templates.some((t) => t.id === 'broken')).toBe(false);
    expect((await s2.api(ADA).listBoards()).map((b) => b.id)).toEqual(['weekly']);

    await s2.api(ADA).createBoard({ name: 'Copy' });
    const result = await s2.api(ADA).applyTemplate('copy', { template: 'weekly' });
    expect(result.status).toBe('applied');
    const copy = await s2.api(ADA).getBoard('copy');
    const original = await s2.api(ADA).getBoard('weekly');
    expect(Object.keys(copy.nodes)).toHaveLength(3);
    for (const id of Object.keys(copy.nodes)) expect(original.nodes[id]).toBeUndefined();
    for (const node of Object.values(copy.nodes)) expect(node.createdBy).toBe('ada');
    expect(copy.comments).toBeUndefined();
    expect(findOverlaps(copy)).toEqual([]);
    await expect(s2.api(ADA).applyTemplate('copy', { template: 'broken' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('plugins', () => {
  it('add types, a template and an exporter, and keep a running total (the example plugin)', async () => {
    const s = await start({ plugins: [createEstimatesPlugin()] });
    await s.api(ADA).createBoard({ name: 'Plan' });

    const schema = await s.api(BOT).schema();
    expect(schema.nodeTypes.find((t) => t.type === 'x:estimate')).toMatchObject({
      source: 'plugin',
      plugin: 'estimates',
      color: 'teal',
    });
    const invalid = await s.api(BOT).apply('plan', {
      ops: [{ op: 'add_node', node: { type: 'x:estimate', title: 'No points' } }],
    });
    expect(invalid.errors?.[0]?.message).toContain('props.points is required');

    const listed = (await s.api(BOT).templates()).templates.find((t) => t.id === 'estimation');
    expect(listed).toMatchObject({ source: 'plugin', plugin: 'estimates', nodeCount: 4 });
    expect((await s.api(BOT).applyTemplate('plan', { template: 'estimation' })).status).toBe(
      'applied',
    );

    const total = await waitFor(
      async () =>
        Object.values((await s.api(ADA).getBoard('plan')).nodes).find((n) =>
          n.title.startsWith('Estimate total'),
        ),
      { what: 'the total note' },
    );
    expect(total.title).toBe('Estimate total: 8 points (2 estimates)');
    expect(total.createdBy).toBe('plugin-estimates');

    await s.api(BOT).apply('plan', {
      ops: [
        {
          op: 'add_node',
          node: { type: 'x:estimate', title: '=HYPERLINK("x")', props: { points: 2 } },
        },
      ],
    });
    await waitFor(
      async () =>
        Object.values((await s.api(ADA).getBoard('plan')).nodes).some(
          (n) => n.title === 'Estimate total: 10 points (3 estimates)',
        ),
      { what: 'the updated total' },
    );

    const csv = await rawRequest(s.url, { path: '/api/boards/plan/export?format=csv' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="plan.csv"');
    const rows = csv.text.trim().split('\r\n');
    expect(rows[0]).toBe('id,title,status,points,confidence,owner,due');
    expect(rows).toHaveLength(4);
    expect(csv.text).toContain(`"'=HYPERLINK(""x"")"`);
    const exported = await s.api(BOT).exportBoard('plan', { format: 'csv' });
    expect(exported.mime).toBe('text/csv');

    const info = await api(s, 'GET', '/api/info');
    expect(info.json.plugins).toEqual([{ name: 'estimates', version: '1.0.0', warnings: [] }]);
    expect(info.json.exporters.find((e: { name: string }) => e.name === 'csv')).toEqual({
      name: 'csv',
      extension: '.csv',
      mime: 'text/csv',
      description: 'the estimates of a board, one row each',
      source: 'plugin',
      plugin: 'estimates',
    });
    expect(info.json.exporters.find((e: { name: string }) => e.name === 'svg').source).toBe(
      'builtin',
    );
  });

  it('let the project config win a type clash, with a warning in /api/info', async () => {
    const s = await start({ plugins: [createEstimatesPlugin()] });
    await s.api(ADA).setConfig(withBug({ 'x:estimate': { label: 'Project estimate' } }));
    const info = await api(s, 'GET', '/api/info');
    expect(info.json.plugins[0].warnings).toEqual([
      'node type x:estimate is also declared by .openboard/config.json, whose definition is used',
    ]);
    const schema = await s.api(BOT).schema();
    expect(schema.nodeTypes.find((t) => t.type === 'x:estimate')).toMatchObject({
      label: 'Project estimate',
      source: 'project',
    });
    await s.api(ADA).createBoard({ name: 'Plan' });
    const applied = await s.api(BOT).apply('plan', {
      ops: [{ op: 'add_node', node: { type: 'x:estimate', title: 'No points needed' } }],
    });
    expect(applied.status).toBe('applied');
  });

  it('isolate onBatch failures and slow handlers from applies', async () => {
    const seen: string[] = [];
    let release: () => void = () => {};
    const failing: OpenBoardPlugin = {
      name: 'failing',
      onBatch() {
        throw new Error('hook exploded');
      },
    };
    const slow: OpenBoardPlugin = {
      name: 'slow',
      async onBatch(event) {
        seen.push(`${event.boardId}:${event.batch.reason ?? ''}`);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };
    const s = await start({ plugins: [failing, slow] });
    await s.api(ADA).createBoard({ name: 'Plan' });
    const started = Date.now();
    for (const title of ['a', 'b']) {
      const result = await s.api(BOT).apply('plan', {
        reason: title,
        ops: [{ op: 'add_node', node: { type: 'note', title } }],
      });
      expect(result.status).toBe('applied');
    }
    expect(Date.now() - started).toBeLessThan(2000);
    await waitFor(() => lines.some((l) => l.includes('hook exploded')), { what: 'the log line' });
    expect(lines.find((l) => l.includes('hook exploded'))).toContain('plugin "failing": onBatch');
    await waitFor(() => seen.length === 1, { what: 'the first batch' });
    await sleep(100);
    expect(seen).toEqual(['plan:a']);
    release();
    await waitFor(() => seen.length === 2, { what: 'the second batch, in order' });
    expect(seen).toEqual(['plan:a', 'plan:b']);
    release();
  });

  it('report a batch with its layout, once, and browser-free sources too (undo)', async () => {
    const batches: Array<{ id: string; nodeIds: string[]; source: string }> = [];
    const s = await start({
      plugins: [
        {
          name: 'watcher',
          onBatch: ({ batch, board }) => {
            batches.push({ id: batch.id, nodeIds: batch.nodeIds, source: batch.source });
            expect(Object.keys(board().nodes).length).toBeGreaterThanOrEqual(0);
          },
        },
      ],
    });
    await s.api(ADA).createBoard({ name: 'Plan' });
    const applied = await s.api(BOT).apply('plan', {
      ops: [{ op: 'add_node', node: { type: 'note', title: 'a' } }],
    });
    await waitFor(() => batches.length === 1, { what: 'the apply' });
    expect(batches[0]?.id).toBe(applied.batchId);
    await s.api(BOT).undo('plan', { batchId: applied.batchId as string });
    await waitFor(() => batches.length === 2, { what: 'the undo' });
    expect(batches[1]?.source).toBe('undo');
    await sleep(100);
    expect(batches).toHaveLength(2);
  });

  it('set up in order and tear down in reverse when the server closes', async () => {
    const events: string[] = [];
    const plugin = (name: string): OpenBoardPlugin => ({
      name,
      async setup(ctx) {
        events.push(`setup ${name}`);
        ctx.log('ready');
        expect(ctx.root).toBe(root);
        expect((await ctx.api(ADA).listBoards()).length).toBe(0);
        return async () => {
          events.push(`teardown ${name}`);
        };
      },
    });
    const s = await start({ plugins: [plugin('one'), plugin('two'), { name: 'three' }] });
    expect(events).toEqual(['setup one', 'setup two']);
    expect(lines).toContain('plugin one: ready');
    await s.close();
    servers = [];
    expect(events).toEqual(['setup one', 'setup two', 'teardown two', 'teardown one']);
  });

  it('stop the start when a setup fails, tearing down those already set up', async () => {
    const events: string[] = [];
    await expect(
      start({
        plugins: [
          { name: 'good', setup: () => () => void events.push('teardown good') },
          {
            name: 'bad',
            setup: () => {
              throw new Error('no database');
            },
          },
        ],
      }),
    ).rejects.toThrow('plugin "bad" failed to set up: no database');
    expect(events).toEqual(['teardown good']);
    // The root is free again.
    await start();
  });

  it('refuse clashes at startup, naming both plugins', async () => {
    await expect(
      start({
        plugins: [
          { name: 'dup', version: '1' },
          { name: 'dup', version: '2' },
        ],
      }),
    ).rejects.toThrow(/two plugins are named "dup" \(plugin "dup" 1 and plugin "dup" 2/);
    const typed = (name: string): OpenBoardPlugin => ({
      name,
      nodeTypes: { 'x:estimate': { label: 'E' } },
    });
    await expect(start({ plugins: [typed('a'), typed('b')] })).rejects.toThrow(
      'plugin "b" and plugin "a" both provide node type x:estimate',
    );
    await expect(
      start({
        plugins: [
          {
            name: 'a',
            exporters: [
              { name: 'json', extension: '.j', mime: 'a/b', description: '', render: () => '' },
            ],
          },
        ],
      }),
    ).rejects.toThrow('exporter "json" is built in');
    await expect(
      start({ plugins: [{ name: 'a', templates: [{ ...BUILTIN_TEMPLATES[0]! }] }] }),
    ).rejects.toThrow('is the id of a built-in template');
    await expect(
      start({ plugins: [{ name: 'a', nodeTypes: { bad: { label: 'B' } } }] }),
    ).rejects.toThrow('invalid nodeTypes');
    await expect(start({ plugins: [{ name: 'Not A Name' }] })).rejects.toThrow('needs a name');
  });

  it('stay with their own server: two servers in one process do not share them', async () => {
    const other = await tempRoot();
    try {
      const a = await start({ plugins: [createEstimatesPlugin()] });
      const b = await start({}, other);
      await a.api(ADA).createBoard({ name: 'Plan' });
      await b.api(ADA).createBoard({ name: 'Plan' });
      expect((await a.api(BOT).schema()).nodeTypes.some((t) => t.type === 'x:estimate')).toBe(true);
      expect((await b.api(BOT).schema()).nodeTypes.some((t) => t.type === 'x:estimate')).toBe(
        false,
      );
      expect((await b.api(BOT).templates()).templates.some((t) => t.id === 'estimation')).toBe(
        false,
      );
      const res = await rawRequest(b.url, { path: '/api/boards/plan/export?format=csv' });
      expect(res.status).toBe(400);
      expect(res.json.error.message).toContain('unknown export format "csv"');
      // Without points, x:estimate is just an undeclared type on b.
      const applied = await b.api(BOT).apply('plan', {
        ops: [{ op: 'add_node', node: { type: 'x:estimate', title: 'free' } }],
      });
      expect(applied.status).toBe('applied');
      expect((await api(b, 'GET', '/api/info')).json.plugins).toBeUndefined();
    } finally {
      await removeRoot(other);
    }
  });

  it('add importers, by name or by file extension', async () => {
    const s = await start({
      plugins: [
        {
          name: 'lines',
          importers: [
            {
              name: 'lines',
              extensions: ['.lines'],
              description: 'one note per line',
              parse: (text) => ({
                ops: text
                  .split('\n')
                  .filter(Boolean)
                  .map((title) => ({
                    op: 'add_node' as const,
                    node: { type: 'note' as const, title },
                  })),
                warnings: [],
              }),
            },
          ],
        },
      ],
    });
    await s.api(ADA).createBoard({ name: 'Plan' });
    const byName = await s.api(BOT).importInto('plan', { format: 'lines', text: 'a\nb' });
    expect(byName).toMatchObject({ status: 'applied', format: 'lines' });
    const byFile = await s.api(BOT).importInto('plan', { filename: 'x.lines', text: 'c' });
    expect(byFile.format).toBe('lines');
    expect(Object.keys((await s.api(BOT).getBoard('plan')).nodes)).toHaveLength(3);
  });
});

describe('shared mode', () => {
  const PUBLIC = 'https://board.example.com';
  let server: OpenBoardServer;
  const remote = (method: string, pathname: string, token: string, body?: unknown) =>
    rawRequest(server.url, {
      method,
      path: pathname,
      headers: { host: 'board.example.com', authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  it('lets every role read the schema and templates, and editors apply them', async () => {
    server = await start({ shared: true, publicUrl: PUBLIC });
    const owner = server.api(ADA);
    await owner.createBoard({ name: 'Plan' });
    const token = async (role: 'viewer' | 'commenter' | 'editor', kind: 'human' | 'agent') =>
      (await owner.grantAccess({ label: `${role} ${kind}`, role, kind })).token;
    const results: Record<string, number[]> = {};
    for (const role of ['viewer', 'commenter', 'editor'] as const) {
      const t = await token(role, 'agent');
      const responses: RawResponse[] = [
        await remote('GET', '/api/schema?board=plan', t),
        await remote('GET', '/api/templates', t),
        await remote('POST', '/api/boards/plan/template', t, { template: 'kanban', dryRun: true }),
        await remote('POST', '/api/boards', t, { name: `From ${role}`, template: 'kanban' }),
      ];
      results[role] = responses.map((r) => r.status);
    }
    expect(results).toEqual({
      viewer: [200, 200, 403, 403],
      commenter: [200, 200, 403, 403],
      editor: [200, 200, 200, 201],
    });
    // Declaring types is a settings change: owners only, people only.
    const editor = await token('editor', 'human');
    expect((await remote('PUT', '/api/config', editor, withBug())).status).toBe(403);
  });
});
