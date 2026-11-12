import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type OpenBoardServer, startServer } from '@openboard/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorForClient } from './actor.js';
import { createHttpHandler, type McpHttpHandler } from './http.js';

let root: string;
let server: OpenBoardServer;
let handler: McpHttpHandler;
const clients: Client[] = [];

/** The agent session ids `resolveApi` was given, in order. */
const sessionIds: string[] = [];

async function setup(idleTimeoutMs?: number) {
  handler = createHttpHandler({
    resolveApi: (client) => {
      sessionIds.push(client.session);
      return server.api(actorForClient(client, {}), { session: client.session });
    },
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
  });
  server.mount('/mcp', handler);
}

async function connectAs(name: string) {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', server.url));
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

const textOf = (result: { content: unknown }) =>
  (result.content as { type: string; text: string }[])[0]?.text ?? '';

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'openboard-mcp-http-')));
  server = await startServer({ root, port: 0 });
  await server.api({ id: 'ada', kind: 'human', name: 'Ada' }).createBoard({
    id: 'main',
    name: 'Main',
  });
});

afterEach(async () => {
  sessionIds.splice(0);
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
  await handler.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
});

describe('MCP over Streamable HTTP', () => {
  it('gives each session its own actor and cursor', async () => {
    await setup();
    const alpha = await connectAs('alpha-agent');
    const beta = await connectAs('beta-agent');
    expect(handler.sessionCount).toBe(2);
    expect(alpha.transport.sessionId).not.toBe(beta.transport.sessionId);

    const { tools } = await alpha.client.listTools();
    expect(tools).toHaveLength(14);

    await alpha.client.callTool({ name: 'board_outline', arguments: {} });
    await beta.client.callTool({ name: 'board_outline', arguments: {} });
    // Each MCP session is its own agent session, named by its MCP session id.
    expect(sessionIds).toEqual([alpha.transport.sessionId, beta.transport.sessionId]);
    const applied = await alpha.client.callTool({
      name: 'board_apply',
      arguments: { ops: [{ op: 'add_node', node: { type: 'note', title: 'From alpha' } }] },
    });
    expect(textOf(applied)).toMatch(/^Applied: added 1 node/);
    expect(textOf(applied)).not.toContain('Note:');

    // Beta sees alpha's write as a change by someone else.
    const read = await beta.client.callTool({ name: 'board_read', arguments: {} });
    expect(textOf(read)).toContain('Note: 1 change by others');
    const changes = await beta.client.callTool({ name: 'board_changes', arguments: {} });
    expect(textOf(changes)).toContain('Alpha Agent (agent)');

    await beta.client.callTool({
      name: 'board_apply',
      arguments: { ops: [{ op: 'add_node', node: { type: 'note', title: 'From beta' } }] },
    });
    const board = await server.api({ id: 'ada', kind: 'human', name: 'Ada' }).getBoard('main');
    const authors = Object.values(board.nodes).map((node) => `${node.title}: ${node.createdBy}`);
    expect(authors.sort()).toEqual(['From alpha: alpha-agent', 'From beta: beta-agent']);
    expect(board.actors['beta-agent']?.name).toBe('Beta Agent');
  });

  it('ends a session on DELETE and rejects its id afterwards', async () => {
    await setup();
    const alpha = await connectAs('alpha-agent');
    const id = alpha.transport.sessionId as string;
    expect(handler.sessionCount).toBe(1);
    await alpha.transport.terminateSession();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handler.sessionCount).toBe(0);

    const response = await fetch(new URL('/mcp', server.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': id,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(404);
  });

  it('closes idle sessions', async () => {
    await setup(50);
    await connectAs('alpha-agent');
    expect(handler.sessionCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(handler.sessionCount).toBe(0);
  });

  it('refuses requests that neither initialize nor carry a session', async () => {
    await setup();
    const response = await fetch(new URL('/mcp', server.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      'initialize',
    );
  });
});
