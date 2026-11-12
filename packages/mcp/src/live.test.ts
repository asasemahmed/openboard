/**
 * Live work over MCP: the agent session id handed to `resolveApi`, claims,
 * and the `claimed` refusal, against a real in-process server.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Actor } from '@openboard/core';
import { type OpenBoardServer, startServer } from '@openboard/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorForClient, type SessionInfo, sessionFromEnv } from './actor.js';
import { createMcpServer, type McpServerOptions } from './server.js';
import { TOOL_NAMES } from './tools.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };

let root: string;
let server: OpenBoardServer;
const clients: Client[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'openboard-mcp-live-')));
  server = await startServer({ root, port: 0 });
  await server.api(ADA).createBoard({ id: 'main', name: 'Main' });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function open(name: string, options: Partial<McpServerOptions> = {}) {
  const seen: SessionInfo[] = [];
  const mcp = createMcpServer({
    resolveApi: (client) => {
      seen.push(client);
      return server.api(actorForClient(client, {}), { session: client.session });
    },
    ...options,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: tool, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { text: content[0]?.text ?? '', isError: result.isError === true };
  };
  return { call, seen };
}

async function task(title = 'Build the API') {
  const result = await server.api(ADA).apply('main', {
    ops: [{ op: 'add_node', ref: 't', node: { type: 'task', title, status: 'todo' } }],
  });
  return result.refs.t as string;
}

describe('agent sessions', () => {
  it('hands resolveApi one session id per MCP server, or the one it was given', async () => {
    const generated = await open('alpha-agent');
    await generated.call('board_list');
    await generated.call('board_list');
    expect(generated.seen).toHaveLength(1);
    expect(generated.seen[0]?.session).toMatch(/^[0-9a-f-]{36}$/);

    const given = await open('beta-agent', { session: 'hook-session-1' });
    await given.call('board_list');
    expect(given.seen[0]).toEqual({
      name: 'beta-agent',
      version: '1.0.0',
      session: 'hook-session-1',
    });
  });

  it('reads OPENBOARD_SESSION only when it is a valid id', () => {
    expect(sessionFromEnv({ OPENBOARD_SESSION: ' abc-123 ' })).toBe('abc-123');
    expect(sessionFromEnv({ OPENBOARD_SESSION: 'has space' })).toBeUndefined();
    expect(sessionFromEnv({})).toBeUndefined();
  });
});

describe('board_claim', () => {
  it('is listed with a description that says when to use it', async () => {
    expect(TOOL_NAMES).toContain('board_claim');
  });

  it('claims, refuses a second agent with who and until when, and releases', async () => {
    const id = await task();
    const alpha = await open('alpha-agent');
    const beta = await open('beta-agent');

    const claimed = await alpha.call('board_claim', {
      nodeIds: [id],
      note: 'Writing the routes',
      minutes: 30,
    });
    expect(claimed.isError).toBe(false);
    expect(claimed.text).toMatch(
      new RegExp(`^You hold 1 claim on board main:\\n {2}${id} "Build the API" until \\S+$`),
    );

    const refused = await beta.call('board_claim', { nodeIds: [id] });
    expect(refused.isError).toBe(false);
    expect(refused.text).toContain(`${id} "Build the API": by Alpha Agent (agent) until `);
    expect(refused.text).toContain('Nothing was claimed: claiming is all or nothing.');
    expect(refused.text).toContain('Do not retry in a loop');

    const other = await task('Write docs');
    const partial = await beta.call('board_claim', { nodeIds: [id, other], partial: true });
    expect(partial.text).toContain(`You hold 1 claim on board main:\n  ${other} "Write docs"`);
    expect(partial.text).toContain('The nodes held by others were left out.');

    const released = await alpha.call('board_claim', { nodeIds: [id], release: true });
    expect(released.text.split('\n')[0]).toBe('Board main: released 1 claim.');
    const now = await beta.call('board_claim', { nodeIds: [id] });
    expect(now.text).toContain('You hold 2 claims on board main:');
  });

  it("explains board_apply's claimed refusal and says not to retry in a loop", async () => {
    const id = await task();
    const alpha = await open('alpha-agent');
    const beta = await open('beta-agent');
    await alpha.call('board_claim', { nodeIds: [id], note: 'Writing the routes' });
    const result = await beta.call('board_apply', {
      ops: [{ op: 'update_node', id, patch: { status: 'in_progress' } }],
    });
    expect(result.isError).toBe(true);
    const lines = result.text.split('\n');
    expect(lines[0]).toBe('The batch was refused (1 problem):');
    expect(lines[1]).toMatch(
      new RegExp(
        `^ops\\[0\\]: node "${id}" \\("Build the API"\\) is claimed by Alpha Agent until \\S+ \\("Writing the routes"\\)`,
      ),
    );
    expect(lines[2]).toContain('ops[0] touches nodes another agent is working on');
    expect(lines[2]).toContain('Do not retry in a loop.');
    expect(lines[2]).toContain('board_comment');
    expect(lines[2]).toContain('board_ask');
  });

  it('names an unknown node', async () => {
    const { call } = await open('alpha-agent');
    const result = await call('board_claim', { nodeIds: ['n_nope'] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Find node ids with board_read.');
  });
});
