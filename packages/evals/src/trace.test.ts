import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type Actor, estimateTokens } from '@openboard/core';
import { actorForClient } from '@openboard/mcp';
import { type OpenBoardServer, startServer } from '@openboard/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Endpoint, startEndpoint } from './endpoint.js';
import { Recorder, resultText } from './trace.js';
import { StreamTransport } from './transport.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };

let root: string;
let server: OpenBoardServer;
let endpoint: Endpoint;
let recorder: Recorder;
const clients: Client[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'openboard-evals-trace-')));
  server = await startServer({ root, port: 0 });
  await server.api(ADA).createBoard({ id: 'main', name: 'Main' });
  recorder = new Recorder();
  endpoint = await startEndpoint({
    recorder,
    resolveApi: (client) =>
      server.api(actorForClient(client, { OPENBOARD_AGENT_ID: 'eval-agent' }), {
        session: client.session,
      }),
  });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await endpoint.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function overSocket(name = 'test-agent'): Promise<Client> {
  const socket = connect(endpoint.tcp);
  await new Promise((resolve) => socket.once('connect', resolve));
  const client = new Client({ name, version: '1.2.3' });
  await client.connect(new StreamTransport(socket));
  clients.push(client);
  return client;
}

describe('the recording proxy', () => {
  it('records each tool call with its arguments, result, error flag, timing and token estimates', async () => {
    const client = await overSocket();
    await client.listTools();
    const outline = resultText(await client.callTool({ name: 'board_outline', arguments: {} }));
    const args = {
      ops: [{ op: 'add_node', ref: 'a', node: { type: 'note', title: 'Hello' } }],
      reason: 'Say hello',
    };
    const applied = resultText(await client.callTool({ name: 'board_apply', arguments: args }));
    const refused = resultText(
      await client.callTool({
        name: 'board_apply',
        arguments: { ops: [{ op: 'update_node', id: 'n_missing', patch: { title: 'x' } }] },
      }),
    );

    const { trace } = recorder;
    expect(trace.connections).toBe(1);
    expect(trace.clients).toEqual([{ name: 'test-agent', version: '1.2.3' }]);
    expect(trace.toolListRequests).toBe(1);
    expect(trace.calls.map((c) => [c.seq, c.tool, c.isError])).toEqual([
      [1, 'board_outline', false],
      [2, 'board_apply', false],
      [3, 'board_apply', true],
    ]);
    const [first, second, third] = trace.calls;
    expect(first?.text).toBe(outline.text);
    expect(first?.resultTokens).toBe(estimateTokens(outline.text));
    expect(second?.args).toEqual(args);
    expect(second?.argsTokens).toBe(estimateTokens(JSON.stringify(args)));
    expect(second?.text).toBe(applied.text);
    expect(second?.text).toMatch(/^Applied: added 1 node/);
    expect(third?.text).toBe(refused.text);
    expect(third?.text).toContain('does not exist');
    for (const call of trace.calls) {
      expect(call.durationMs).toBeGreaterThanOrEqual(0);
      expect(call.startedMs).toBeGreaterThanOrEqual(0);
    }
    // The call landed on the board as the fixed agent actor.
    const board = await server.api(ADA).getBoard('main');
    expect(Object.values(board.nodes).map((n) => [n.title, n.createdBy])).toEqual([
      ['Hello', 'eval-agent'],
    ]);
  });

  it('records a call the input schema rejects as an error', async () => {
    const client = await overSocket();
    const result = await client.callTool({
      name: 'board_apply',
      arguments: { ops: [{ op: 'explode' }] },
    });
    expect(result.isError).toBe(true);
    expect(recorder.trace.calls).toHaveLength(1);
    expect(recorder.trace.calls[0]?.isError).toBe(true);
    expect(recorder.trace.calls[0]?.text.length).toBeGreaterThan(0);
  });

  it('holds a call back until beforeCall resolves, and reports it after it was answered', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    recorder.hooks = {
      beforeCall: async (tool) => {
        order.push(`before ${tool}`);
        if (tool === 'board_read') await held;
      },
      afterCall: (record) => order.push(`after ${record.tool}`),
    };
    const client = await overSocket();
    await client.callTool({ name: 'board_outline', arguments: {} });
    const reading = client.callTool({ name: 'board_read', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(['before board_outline', 'after board_outline', 'before board_read']);
    // Meanwhile a person edits the board; the held read must see it.
    await server
      .api(ADA)
      .apply('main', { ops: [{ op: 'add_node', node: { type: 'note', title: 'By Ada' } }] });
    release();
    const read = resultText(await reading);
    expect(read.text).toContain('By Ada');
    expect(order.at(-1)).toBe('after board_read');
  });

  it('records every connection, over Streamable HTTP too', async () => {
    await overSocket('first');
    const client = new Client({ name: 'http-agent', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
    clients.push(client);
    const { tools } = await client.listTools();
    expect(tools.length).toBe(14);
    await client.callTool({ name: 'board_list', arguments: {} });
    expect(recorder.trace.connections).toBe(2);
    expect(recorder.trace.clients.map((c) => c.name)).toEqual(['first', 'http-agent']);
    expect(recorder.trace.calls.map((c) => [c.connection, c.tool])).toEqual([[2, 'board_list']]);
    expect(recorder.trace.calls[0]?.text).toContain('main "Main"');
  });

  it('serves stdio through the relay command', async () => {
    const client = new Client({ name: 'stdio-agent', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: endpoint.stdio.command,
        args: endpoint.stdio.args,
        stderr: 'pipe',
      }),
    );
    clients.push(client);
    const result = resultText(await client.callTool({ name: 'board_outline', arguments: {} }));
    expect(result.text).toContain('Board main "Main"');
    expect(recorder.trace.clients.map((c) => c.name)).toEqual(['stdio-agent']);
    expect(recorder.trace.calls[0]?.tool).toBe('board_outline');
    expect(client.getInstructions()).toContain('board_outline');
  });
});
