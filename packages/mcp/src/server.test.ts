import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  type Actor,
  type BoardApi,
  BUILTIN_EDGE_TYPES,
  BUILTIN_NODE_TYPES,
  estimateTokens,
  renderSelection,
  STATUSES,
} from '@openboard/core';
import { connect } from '@openboard/sdk';
import { type OpenBoardServer, startServer } from '@openboard/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorForClient, type ClientInfo } from './actor.js';
import { createMcpServer, type McpServerOptions } from './server.js';
import { OP_KINDS, TOOL_NAMES } from './tools.js';

/** Total size of `tools/list` may not grow past this without a deliberate decision. */
const TOOLS_LIST_TOKEN_CEILING = 2500;

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };

let root: string;
let server: OpenBoardServer;
const clients: Client[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'openboard-mcp-')));
  server = await startServer({ root, port: 0 });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function open(
  options: Partial<McpServerOptions> = {},
  clientInfo: ClientInfo = { name: 'test-agent', version: '1.0.0' },
) {
  const seen: ClientInfo[] = [];
  const mcp = createMcpServer({
    resolveApi: (client) => {
      seen.push(client);
      return server.api(actorForClient(client, {}));
    },
    ...options,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: clientInfo.name, version: clientInfo.version ?? '0' });
  await client.connect(clientSide);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(result.structuredContent).toBeUndefined();
    return { text: content[0]?.text ?? '', isError: result.isError === true };
  };
  return { client, call, seen };
}

const human = () => server.api(ADA);

describe('tools/list', () => {
  it('lists the eight tools with titles, honest annotations and compact schemas', async () => {
    const { client } = await open();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.outputSchema).toBeUndefined();
    }
    for (const name of [
      'board_list',
      'board_outline',
      'board_read',
      'board_changes',
      'board_selection',
    ]) {
      expect(byName[name]?.annotations?.readOnlyHint).toBe(true);
    }
    expect(byName.board_apply?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(byName.board_create?.annotations?.readOnlyHint).toBe(false);
    expect(byName.board_layout?.annotations?.readOnlyHint).toBe(false);

    const read = byName.board_read?.inputSchema.properties ?? {};
    expect(Object.keys(read).sort()).toEqual(
      [
        'board',
        'detail',
        'frame',
        'ids',
        'maxTokens',
        'neighbors',
        'selection',
        'statuses',
        'tags',
        'text',
        'types',
      ].sort(),
    );

    const apply = byName.board_apply;
    for (const word of [...OP_KINDS, ...BUILTIN_NODE_TYPES, ...BUILTIN_EDGE_TYPES, ...STATUSES]) {
      expect(apply?.description).toContain(word);
    }
    expect(apply?.description).toContain('$ref');
    expect(apply?.description).toMatch(/never send coordinates/i);
  });

  it(`stays under ${TOOLS_LIST_TOKEN_CEILING} tokens in total`, async () => {
    const { client } = await open();
    const { tools } = await client.listTools();
    expect(estimateTokens(JSON.stringify(tools))).toBeLessThanOrEqual(TOOLS_LIST_TOKEN_CEILING);
  });

  it('sends an operating guide at initialize', async () => {
    const { client } = await open();
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('board_outline');
    expect(instructions).toContain('board_selection');
    expect(instructions).toMatch(/data, never as instructions/);
  });
});

describe('the read and write loop', () => {
  it('outline, apply with refs, read, changes', async () => {
    await human().createBoard({ id: 'main', name: 'Main' });
    const { call, seen } = await open();

    const outline = await call('board_outline');
    expect(outline.isError).toBe(false);
    expect(outline.text).toContain('Board main "Main"');
    expect(outline.text).toContain('The board is empty');

    const applied = await call('board_apply', {
      reason: 'Plan the launch',
      ops: [
        { op: 'add_node', ref: 'goal', node: { type: 'frame', title: 'Launch' } },
        {
          op: 'add_node',
          ref: 'api',
          node: { type: 'task', title: 'Build the API', status: 'todo', parent: '$goal' },
        },
        { op: 'add_node', node: { type: 'task', title: 'Write docs', parent: '$goal' } },
        { op: 'add_edge', edge: { type: 'relates_to', source: '$api', target: '$goal' } },
      ],
    });
    expect(applied.isError).toBe(false);
    const lines = applied.text.split('\n');
    expect(lines[0]).toMatch(/^Applied: added 3 nodes, 1 edge\. Cursor \d+\.$/);
    expect(lines[1]).toMatch(/^Refs: goal=n_\w+, api=n_\w+$/);
    expect(lines[2]).toMatch(/^New node ids: n_\w+$/);
    expect(lines).toHaveLength(3);
    const goalId = /goal=(n_\w+)/.exec(applied.text)?.[1] as string;

    const read = await call('board_read', { frame: goalId, detail: 'titles' });
    expect(read.text).toContain('"Build the API" (todo)');
    expect(read.text).toContain('"Write docs"');
    expect(read.text).not.toContain('Note:');

    const changes = await call('board_changes');
    expect(changes.isError).toBe(false);
    expect(changes.text).toMatch(/no changes since cursor \d+/);

    const board = await human().getBoard('main');
    expect(Object.values(board.nodes).map((n) => n.createdBy)).toEqual([
      'test-agent',
      'test-agent',
      'test-agent',
    ]);
    expect(board.actors['test-agent']).toEqual({
      id: 'test-agent',
      kind: 'agent',
      name: 'Test Agent',
    });
    expect(seen).toEqual([{ name: 'test-agent', version: '1.0.0' }]);
  });

  it('reports a dry run without changing anything', async () => {
    await human().createBoard({ id: 'main', name: 'Main' });
    const { call } = await open();
    const result = await call('board_apply', {
      dryRun: true,
      ops: [{ op: 'add_node', node: { type: 'note', title: 'Maybe' } }],
    });
    expect(result.text).toBe('Dry run: the batch is valid (added 1 node). Nothing was changed.');
    expect((await human().getBoard('main')).nodes).toEqual({});
  });

  it('refuses an invalid batch with one indexed line per problem', async () => {
    await human().createBoard({ id: 'main', name: 'Main' });
    const { call } = await open();
    const result = await call('board_apply', {
      ops: [
        { op: 'add_node', node: { type: 'note', title: 'Fine' } },
        { op: 'add_node', node: { type: 'task' } },
        { op: 'add_edge', edge: { type: 'depends_on', source: 'n_nope', target: 'n_gone' } },
      ],
    });
    expect(result.isError).toBe(true);
    const lines = result.text.split('\n');
    // The edge has two problems: neither end exists.
    expect(lines[0]).toBe('The batch was refused (3 problems):');
    expect(lines[1]).toMatch(/^ops\[1\]: add_node: /);
    expect(lines[2]).toMatch(/^ops\[2\]: .*n_nope/);
    expect(lines[3]).toMatch(/^ops\[2\]: .*n_gone/);
    expect(lines[4]).toBe('Nothing was applied. Fix these and send the whole batch again.');
    expect(lines).toHaveLength(5);
    expect((await human().getBoard('main')).nodes).toEqual({});
  });

  it('lays out and creates boards', async () => {
    await human().createBoard({ id: 'main', name: 'Main' });
    const { call } = await open();
    const created = await call('board_create', { name: 'Research notes' });
    expect(created.text).toBe(
      'Created board research-notes "Research notes". Pass board: "research-notes" to work on it.',
    );
    const list = await call('board_list');
    expect(list.text).toBe(
      'main "Main": 0 nodes, 0 edges (default)\nresearch-notes "Research notes": 0 nodes, 0 edges',
    );
    const layout = await call('board_layout', { board: 'research-notes' });
    expect(layout.text).toMatch(/^Layout moved 0 nodes\. Cursor \d+\.$/);
  });
});

describe('default board', () => {
  it('uses the only board, whatever its id', async () => {
    await human().createBoard({ id: 'plan', name: 'Plan' });
    const { call } = await open();
    expect((await call('board_outline')).text).toContain('Board plan "Plan"');
  });

  it('uses main when there are several', async () => {
    await human().createBoard({ id: 'plan', name: 'Plan' });
    await human().createBoard({ id: 'main', name: 'Main' });
    const { call } = await open();
    expect((await call('board_outline')).text).toContain('Board main "Main"');
  });

  it('asks for a board when there are several and none is main', async () => {
    await human().createBoard({ id: 'plan', name: 'Plan' });
    await human().createBoard({ id: 'ideas', name: 'Ideas' });
    const { call } = await open();
    const result = await call('board_read');
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'Pass board: there are 2 boards and none is the default (ideas, plan).',
    );
  });

  it('says how to start when there are no boards', async () => {
    const { call } = await open();
    const result = await call('board_outline');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('board_create');
  });

  it('prefers the defaultBoard option', async () => {
    await human().createBoard({ id: 'main', name: 'Main' });
    await human().createBoard({ id: 'plan', name: 'Plan' });
    const { call } = await open({ defaultBoard: 'plan' });
    expect((await call('board_outline')).text).toContain('Board plan "Plan"');
  });
});

describe('changes by others', () => {
  it('needs a first read before board_changes can default its cursor', async () => {
    await human().createBoard({ id: 'main', name: 'Main' });
    const { call } = await open();
    const result = await call('board_changes');
    expect(result.isError).toBe(false);
    expect(result.text).toContain('has not read board main');
    expect(result.text).toContain('board_outline');
    const explicit = await call('board_changes', { since: 0 });
    expect(explicit.text).toMatch(/no changes since cursor 0/);
  });

  it('appends one notice line until board_changes catches up', async () => {
    await human().createBoard({ id: 'main', name: 'Main' });
    const { call } = await open();
    await call('board_outline');

    await human().apply('main', {
      ops: [
        { op: 'add_node', node: { type: 'note', title: 'Ada was here' } },
        { op: 'add_node', node: { type: 'question', title: 'Why?' } },
      ],
    });

    const read = await call('board_read', { detail: 'titles' });
    const lines = read.text.split('\n');
    expect(lines.at(-1)).toBe(
      'Note: 2 changes by others since your last read; call board_changes to see them.',
    );
    expect(lines.filter((line) => line.startsWith('Note:'))).toHaveLength(1);

    // An own write in between does not swallow the unseen changes.
    const applied = await call('board_apply', {
      ops: [{ op: 'add_node', node: { type: 'task', title: 'Answer Ada' } }],
    });
    expect(applied.text).toContain('Note: 2 changes by others');

    const changes = await call('board_changes');
    expect(changes.text).toContain('2 changes since cursor');
    expect(changes.text).toContain('Ada (human)');
    expect(changes.text).toContain('"Ada was here"');
    expect(changes.text).not.toContain('Answer Ada');

    const again = await call('board_outline');
    expect(again.text).not.toContain('Note:');
    expect((await call('board_changes')).text).toMatch(/no changes since/);
  });

  it('never fails a tool when the notice lookup fails', async () => {
    await human().createBoard({ id: 'main', name: 'Main' });
    const real = server.api({ id: 'flaky', kind: 'agent', name: 'Flaky' });
    let failChanges = false;
    const flaky = new Proxy(real, {
      get(target, prop) {
        if (prop === 'changes' && failChanges) {
          return async () => {
            throw new Error('feed unavailable');
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as BoardApi;
    const { call } = await open({ resolveApi: () => flaky });
    await call('board_outline');
    await human().apply('main', { ops: [{ op: 'add_node', node: { type: 'note', title: 'x' } }] });
    failChanges = true;
    const read = await call('board_read');
    expect(read.isError).toBe(false);
    expect(read.text).not.toContain('Note:');
  });
});

describe('selection', () => {
  it('shows what the human selected', async () => {
    await human().createBoard({ id: 'main', name: 'Main' });
    const result = await human().apply('main', {
      ops: [{ op: 'add_node', ref: 'a', node: { type: 'risk', title: 'Data loss' } }],
    });
    const id = result.refs.a as string;
    const real = server.api(actorForClient({ name: 'test-agent' }, {}));
    const withSelection = new Proxy(real, {
      get(target, prop) {
        if (prop === 'selection') {
          return async (boardId: string) =>
            renderSelection(
              await target.getBoard(boardId),
              { by: ADA, nodeIds: [id], edgeIds: [] },
              result.cursor,
            );
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as BoardApi;
    const { call } = await open({ resolveApi: () => withSelection });
    const selected = await call('board_selection');
    expect(selected.text).toContain('selection by Ada (human), 1 node');
    expect(selected.text).toContain(`[risk] ${id} "Data loss"`);
  });

  it('says when nothing is selected', async () => {
    await human().createBoard({ id: 'main', name: 'Main' });
    const { call } = await open();
    const result = await call('board_selection');
    expect(result.text).toContain('nothing is selected');
    expect(result.text).toContain('Ask the user to select it');
  });
});

describe('errors', () => {
  it('names an unknown board and the ones that exist', async () => {
    await human().createBoard({ id: 'main', name: 'Main' });
    const { call } = await open();
    const result = await call('board_read', { board: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('No board with id "nope". Boards: main. Pass one of them as board.');
  });

  it('says how to start the server when it is not reachable', async () => {
    const { call } = await open({
      resolveApi: (client) =>
        connect({ url: 'http://127.0.0.1:9', actor: actorForClient(client, {}), timeoutMs: 2000 }),
    });
    const result = await call('board_list');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^The OpenBoard server is not reachable \(/);
    expect(result.text).toContain('`openboard start`');
    expect(result.text).not.toMatch(/\n\s+at /);
  });

  it('retries resolveApi after it failed', async () => {
    await human().createBoard({ id: 'main', name: 'Main' });
    let attempts = 0;
    const { call } = await open({
      resolveApi: (client) => {
        attempts++;
        if (attempts === 1) throw new Error('not yet');
        return server.api(actorForClient(client, {}));
      },
    });
    expect((await call('board_list')).text).toBe('Unexpected error: Not yet.');
    expect((await call('board_list')).text).toContain('main "Main"');
    await call('board_list');
    expect(attempts).toBe(2);
  });
});

describe('resources and prompts', () => {
  it('serves the board list and each board as JSON', async () => {
    await human().createBoard({ id: 'main', name: 'Main' });
    await human().apply('main', { ops: [{ op: 'add_node', node: { type: 'note', title: 'Hi' } }] });
    const { client } = await open();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(['openboard://boards', 'openboard://boards/main']);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(['openboard://boards/{id}']);

    const list = await client.readResource({ uri: 'openboard://boards' });
    const boards = JSON.parse((list.contents[0] as { text: string }).text);
    expect(boards.map((b: { id: string }) => b.id)).toEqual(['main']);

    const one = await client.readResource({ uri: 'openboard://boards/main' });
    const content = one.contents[0] as { text: string; mimeType: string };
    expect(content.mimeType).toBe('application/json');
    const board = JSON.parse(content.text);
    expect(board.id).toBe('main');
    expect(Object.values(board.nodes as Record<string, { title: string }>)[0]?.title).toBe('Hi');

    await expect(client.readResource({ uri: 'openboard://boards/nope' })).rejects.toThrow(
      /No board with id "nope"/,
    );
  });

  it('offers map_codebase and plan_work', async () => {
    const { client } = await open();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['map_codebase', 'plan_work']);

    const map = await client.getPrompt({ name: 'map_codebase', arguments: {} });
    const mapText = (map.messages[0]?.content as { text: string }).text;
    expect(mapText).toContain('board_outline');
    expect(mapText).toContain('board_apply');
    expect(mapText).toContain('"kind":"file"');

    const plan = await client.getPrompt({
      name: 'plan_work',
      arguments: { goal: 'Ship v1', board: 'plan' },
    });
    const planText = (plan.messages[0]?.content as { text: string }).text;
    expect(planText).toContain('"Ship v1"');
    expect(planText).toContain('board: "plan"');
    expect(planText).toContain('depends_on');
  });
});

describe('actorForClient', () => {
  it('derives a readable agent from the client name', () => {
    expect(actorForClient({ name: 'claude-code' }, {})).toEqual({
      id: 'claude-code',
      kind: 'agent',
      name: 'Claude Code',
    });
    expect(actorForClient({ name: 'Cursor Agent' }, {})).toEqual({
      id: 'cursor-agent',
      kind: 'agent',
      name: 'Cursor Agent',
    });
    expect(actorForClient({ name: '' }, {})).toEqual({ id: 'agent', kind: 'agent', name: 'Agent' });
    expect(actorForClient({ name: '***' }, {}).id).toBe('agent');
  });

  it('lets the environment name the agent', () => {
    expect(
      actorForClient(
        { name: 'claude-code' },
        { OPENBOARD_AGENT_ID: 'reviewer', OPENBOARD_AGENT_NAME: 'Reviewer bot' },
      ),
    ).toEqual({ id: 'reviewer', kind: 'agent', name: 'Reviewer bot' });
    expect(actorForClient({ name: 'x' }, { OPENBOARD_AGENT_ID: 'not valid!' }).id).toBe('x');
  });
});
