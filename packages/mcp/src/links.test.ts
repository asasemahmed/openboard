/** board_links against a real server watching real files. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Actor } from '@openboard/core';
import { type OpenBoardServer, startServer } from '@openboard/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorForClient } from './actor.js';
import { createMcpServer } from './server.js';

const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const SOURCE = [
  'export function total(items) {',
  '  return items.reduce((a, b) => a + b, 0);',
  '}',
  '',
].join('\n');

let root: string;
let server: OpenBoardServer;
const clients: Client[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'openboard-mcp-links-')));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/total.ts'), SOURCE);
  server = await startServer({ root, port: 0 });
  await server.api(ADA).createBoard({ id: 'main', name: 'Main' });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await server.close();
  await rm(root, { recursive: true, force: true });
});

async function open() {
  const mcp = createMcpServer({
    resolveApi: (client) => server.api(actorForClient(client, {}), { session: client.session }),
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(clientSide);
  clients.push(client);
  return async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: tool, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { text: content[0]?.text ?? '', isError: result.isError === true };
  };
}

/** Poll until `check` holds; fails after `timeoutMs`. */
async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Wait until the server stored a hash for the node's first link. */
const hashed = (nodeId: string) =>
  until(async () => {
    const node = (await server.api(ADA).getBoard('main')).nodes[nodeId];
    return node?.links?.[0]?.hash ? true : undefined;
  }, 'the link to be hashed');

const stateOf = async (nodeId: string) => {
  const { links } = await server.api(ADA).links('main');
  return links.find((l) => l.nodeId === nodeId)?.state;
};

describe('board_links', () => {
  it('finds a node whose code changed, and is clean again after an update and a refresh', async () => {
    const call = await open();
    const applied = await call('board_apply', {
      ops: [
        {
          op: 'add_node',
          ref: 'c',
          node: {
            type: 'code',
            title: 'total()',
            body: 'Sums the items.',
            links: [{ kind: 'file', target: 'src/total.ts', line: 1, endLine: 3 }],
          },
        },
      ],
    });
    const id = /c=(n_\w+)/.exec(applied.text)?.[1] as string;
    await hashed(id);

    const clean = await call('board_links');
    expect(clean.text).toMatch(/no code link points at changed or missing code/);
    const all = await call('board_links', { all: true });
    expect(all.text).toContain(`${id} "total()"`);
    expect(all.text).toContain('#0 file src/total.ts:1-3 [ok]');

    await writeFile(path.join(root, 'src/total.ts'), SOURCE.replace('a + b, 0', 'a + b.price, 0'));
    await until(async () => ((await stateOf(id)) === 'stale' ? true : undefined), 'the stale mark');

    const stale = await call('board_links');
    expect(stale.isError).toBe(false);
    expect(stale.text).toContain(`${id} "total()"`);
    expect(stale.text).toMatch(/\[stale\]/);
    expect(stale.text).toContain('call board_links with refresh: [its id] to clear the mark.');
    // The stale mark is written to the board too, so the outline counts it.
    await until(async () => {
      const outline = await call('board_outline');
      return outline.text.includes('call board_links to see which.') ? true : undefined;
    }, 'the outline to count the stale link');

    await call('board_apply', {
      ops: [{ op: 'update_node', id, patch: { body: 'Sums the prices of the items.' } }],
    });
    const refreshed = await call('board_links', { refresh: [id] });
    expect(refreshed.text).toMatch(
      /^Refreshed the code links of 1 node: they are now taken to match the code as it is\. Cursor \d+, batch b_\w+\./,
    );
    expect((await call('board_links')).text).toMatch(
      /no code link points at changed or missing code/,
    );
  });

  it("holds a refresh of someone else's node for review, like board_apply", async () => {
    const made = await server.api(ADA).apply('main', {
      ops: [
        {
          op: 'add_node',
          ref: 'c',
          node: {
            type: 'code',
            title: 'total()',
            links: [{ kind: 'file', target: 'src/total.ts' }],
          },
        },
      ],
    });
    const id = made.refs.c as string;
    await hashed(id);
    const call = await open();
    expect((await call('board_links', { refresh: [id] })).text).toBe(
      'Nothing to refresh: the code links of those nodes already match the code.',
    );
    await writeFile(path.join(root, 'src/total.ts'), SOURCE.replace('0);', '1);'));
    await until(async () => ((await stateOf(id)) === 'stale' ? true : undefined), 'the stale mark');
    const result = await call('board_links', { refresh: [id] });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(
      /^Proposed as p_\w+: the batch is waiting for a person to review it/,
    );
    expect(result.text).toContain('Do not re-send the batch');

    expect((await call('board_links', { refresh: 'all', all: true })).text).toContain('not both');
  });
});
