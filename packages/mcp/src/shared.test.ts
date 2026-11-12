/**
 * MCP over HTTP on a server in shared mode: callers authenticate with grant
 * tokens, act as their grant, are held to their role, and keep their sessions
 * to themselves.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Actor, GrantAccessInput } from '@openboard/core';
import { type OpenBoardServer, startServer } from '@openboard/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorForSession } from './actor.js';
import { createHttpHandler, type McpHttpHandler } from './http.js';

const OWNER: Actor = { id: 'owner', kind: 'human', name: 'Owner' };

let root: string;
let server: OpenBoardServer;
let handler: McpHttpHandler;
const clients: Client[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'openboard-mcp-shared-')));
  server = await startServer({ root, port: 0, shared: true });
  handler = createHttpHandler({
    resolveApi: (client) =>
      server.api(actorForSession(client, {}), {
        session: client.session,
        ...(client.caller
          ? {
              role: client.caller.role,
              via: client.caller.via,
              ...(client.caller.grantId ? { grantId: client.caller.grantId } : {}),
            }
          : {}),
      }),
  });
  server.mount('/mcp', (request, caller) => handler(request, caller));
  await owner().createBoard({ id: 'main', name: 'Main' });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
  await handler.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const owner = () => server.api(OWNER);

async function grant(input: Partial<GrantAccessInput> = {}) {
  return owner().grantAccess({ label: 'Remote agent', role: 'editor', kind: 'agent', ...input });
}

async function connectWith(token: string | undefined, name = 'remote-agent') {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', server.url), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: tool, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { text: content[0]?.text ?? '', isError: result.isError === true };
  };
  return { client, transport, call };
}

describe('MCP in shared mode', () => {
  it('lets an editor agent work as its grant, whatever the client calls itself', async () => {
    const { grant: g, token } = await grant({ label: 'CI agent' });
    const { call } = await connectWith(token, 'claude-code');
    expect((await call('board_outline')).isError).toBe(false);
    const applied = await call('board_apply', {
      ops: [{ op: 'add_node', ref: 'n', node: { type: 'note', title: 'From afar' } }],
    });
    expect(applied.isError).toBe(false);
    const id = /n=(n_\w+)/.exec(applied.text)?.[1] as string;
    const node = (await owner().getBoard('main')).nodes[id];
    expect(node?.createdBy).toBe(g.actorId);
    expect(node?.createdBy).not.toBe('claude-code');
  });

  it('lets a viewer read but refuses changes, naming the missing permission', async () => {
    const { token } = await grant({ role: 'viewer', label: 'Watcher' });
    const { call } = await connectWith(token);
    expect((await call('board_read')).isError).toBe(false);
    const refused = await call('board_apply', {
      ops: [{ op: 'add_node', node: { type: 'note', title: 'Nope' } }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Refused: Your access \(viewer\) does not include "board\.edit"/);
    expect(refused.text).toContain('editor access');
    const comment = await call('board_comment', { body: 'Hi' });
    expect(comment.text).toContain('does not include "comment"');
    const undo = await call('board_undo');
    expect(undo.text).toMatch(/^Refused: Your access \(viewer\) does not include "board\.undo"/);
    expect(undo.text).not.toContain('someone else did');
  });

  it('lets a commenter comment and ask, but not change the board', async () => {
    const { token } = await grant({ role: 'commenter', label: 'Reviewer' });
    const { call } = await connectWith(token);
    expect((await call('board_comment', { body: 'Looks good' })).isError).toBe(false);
    expect((await call('board_ask', { question: 'Ship it?', waitSeconds: 0 })).isError).toBe(false);
    expect((await call('board_claim', { nodeIds: ['n_x'] })).text).toContain(
      'does not include "board.edit"',
    );
  });

  it('binds a session to the credentials that opened it', async () => {
    const a = await grant({ label: 'Agent A' });
    const b = await grant({ label: 'Agent B' });
    const { transport, call } = await connectWith(a.token);
    await call('board_outline');
    const sessionId = transport.sessionId as string;
    const hijack = async (headers: Record<string, string>) =>
      fetch(new URL('/mcp', server.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      });
    const other = await hijack({ authorization: `Bearer ${b.token}` });
    expect(other.status).toBe(403);
    expect(await other.text()).toContain('belongs to other credentials');
    // From this machine without credentials: the owner, but still not this session's owner.
    expect((await hijack({})).status).toBe(403);
    expect((await call('board_outline')).isError).toBe(false);
  });

  it("ends a revoked grant's session with a clear refusal", async () => {
    const { grant: g, token } = await grant({ label: 'Temp agent' });
    const { call } = await connectWith(token);
    expect((await call('board_outline')).isError).toBe(false);
    await owner().revokeAccess(g.id);
    await expect(call('board_outline')).rejects.toThrow(
      /unauthorized.*not valid: it is wrong, expired or revoked/,
    );
  });

  it('keeps a local caller as before: the owner at this machine, named after its client', async () => {
    const { call } = await connectWith(undefined, 'local-agent');
    const applied = await call('board_apply', {
      ops: [{ op: 'add_node', ref: 'n', node: { type: 'note', title: 'Local' } }],
    });
    const id = /n=(n_\w+)/.exec(applied.text)?.[1] as string;
    expect((await owner().getBoard('main')).nodes[id]?.createdBy).toBe('local-agent');
  });
});
