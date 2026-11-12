/**
 * Types, templates and waiting on the inbox, against a real server whose
 * project declares a node type in `.openboard/config.json`.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Progress } from '@modelcontextprotocol/sdk/types.js';
import type { Actor } from '@openboard/core';
import { type OpenBoardServer, startServer } from '@openboard/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorForClient } from './actor.js';
import { createMcpServer, type McpServerOptions } from './server.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const CONFIG = {
  version: 1,
  policy: { default: 'review_destructive', agents: {} },
  nodeTypes: {
    'x:experiment': {
      label: 'Experiment',
      description: 'A test of an idea, with what would prove it wrong.',
      color: 'teal',
      icon: 'beaker',
      fields: [
        { key: 'hypothesis', label: 'Hypothesis', kind: 'text', required: true },
        {
          key: 'confidence',
          label: 'Confidence',
          kind: 'select',
          options: ['low', 'medium', 'high'],
        },
      ],
    },
  },
};

let root: string;
let server: OpenBoardServer;
const clients: Client[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'openboard-mcp-extend-')));
  await mkdir(path.join(root, '.openboard'));
  await writeFile(path.join(root, '.openboard/config.json'), JSON.stringify(CONFIG));
  server = await startServer({ root, port: 0 });
  await server.api(ADA).createBoard({ id: 'main', name: 'Main' });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function open(options: Partial<McpServerOptions> = {}) {
  const mcp = createMcpServer({
    resolveApi: (client) => server.api(actorForClient(client, {}), { session: client.session }),
    ...options,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: tool, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { text: content[0]?.text ?? '', isError: result.isError === true };
  };
  return { client, call };
}

describe('board_schema and declared types', () => {
  it('points at board_schema from the outline, lists the type, and checks nodes of it', async () => {
    const { call } = await open();
    const outline = await call('board_outline');
    expect(outline.text).toContain(
      'Custom types: x:experiment: call board_schema for their meaning and fields.',
    );

    const schema = await call('board_schema');
    expect(schema.isError).toBe(false);
    expect(schema.text).toContain('Node types (built-in):');
    expect(schema.text).toContain('x:experiment');
    expect(schema.text).toContain('hypothesis');
    expect(schema.text).toContain('Board main: every node fits its declared type.');

    const valid = await call('board_apply', {
      ops: [
        {
          op: 'add_node',
          node: {
            type: 'x:experiment',
            title: 'Cache the export',
            props: { hypothesis: 'Caching halves export time', confidence: 'medium' },
          },
        },
      ],
    });
    expect(valid.text).toMatch(/^Applied: added 1 node/);

    const invalid = await call('board_apply', {
      ops: [
        {
          op: 'add_node',
          node: { type: 'x:experiment', title: 'No hypothesis', props: { confidence: 'sure' } },
        },
      ],
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toMatch(/^The batch was refused/);
    expect(invalid.text).toMatch(/hypothesis/);
    expect(invalid.text).toMatch(/confidence/);
  });
});

describe('board_template', () => {
  it('lists templates, applies one into a frame, dry-runs, and creates a board from one', async () => {
    const { call } = await open();
    const list = await call('board_template');
    expect(list.text).toMatch(/^\d+ templates\. Apply one with board_template \{template: <id>\}/);
    for (const id of ['feature-plan', 'architecture-map', 'kanban', 'decision-record']) {
      expect(list.text).toContain(`${id} "`);
    }

    const dry = await call('board_template', { template: 'feature-plan', dryRun: true });
    expect(dry.text).toMatch(/^Dry run: the batch is valid \(added \d+ nodes/);
    expect((await server.api(ADA).getBoard('main')).nodes).toEqual({});

    const applied = await call('board_template', { template: 'feature-plan', title: 'CSV export' });
    expect(applied.isError).toBe(false);
    expect(applied.text).toMatch(
      /^Applied: added \d+ nodes, \d+ edges\. Cursor \d+, batch b_\w+\./,
    );
    const board = await server.api(ADA).getBoard('main');
    expect(
      Object.values(board.nodes).some((n) => n.type === 'frame' && n.title === 'CSV export'),
    ).toBe(true);

    const unknown = await call('board_template', { template: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(await call('board_template', { dryRun: true })).toMatchObject({ isError: true });

    const created = await call('board_create', { name: 'Kanban', template: 'kanban' });
    expect(created.text).toBe(
      'Created board kanban "Kanban" from the template kanban. Pass board: "kanban" to work on it.',
    );
    expect(Object.keys((await server.api(ADA).getBoard('kanban')).nodes).length).toBeGreaterThan(0);
  });
});

describe('board_inbox waiting', () => {
  it('waits for a decision and returns it, with progress notifications', async () => {
    const made = await server.api(ADA).apply('main', {
      ops: [{ op: 'add_node', ref: 't', node: { type: 'task', title: 'Ship', status: 'todo' } }],
    });
    const { client, call } = await open({ progressIntervalMs: 100 });
    const proposed = await call('board_apply', {
      ops: [{ op: 'update_node', id: made.refs.t, patch: { status: 'done' } }],
    });
    expect(proposed.text).toContain('to wait for it, call board_inbox with waitSeconds');
    const proposalId = /Proposed as (p_\w+)/.exec(proposed.text)?.[1] as string;

    setTimeout(() => {
      void server.api(ADA).decideProposal('main', proposalId, { action: 'accept', note: 'Fine.' });
    }, 400);
    const events: Progress[] = [];
    const started = Date.now();
    const result = await client.callTool(
      { name: 'board_inbox', arguments: { waitSeconds: 20 } },
      undefined,
      { onprogress: (p) => events.push(p) },
    );
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(text).toContain('decided on your proposal');
    expect(text).toContain('| Fine.');
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]?.message).toBe('Waiting for something in the inbox');
  });

  it('says when nothing arrived in time', async () => {
    const { call } = await open();
    const result = await call('board_inbox', { waitSeconds: 1 });
    expect(result.text).toContain('nothing new in your inbox');
    expect(result.text).toContain('Nothing arrived within 1 s');
  });
});
