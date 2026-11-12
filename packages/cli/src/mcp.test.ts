/**
 * The MCP entry points against real processes: `openboard mcp` spawned from
 * the built bin, and the `/mcp` route of a server started by `start`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { findRunningServer } from './lib/server.js';
import { captureIo, randomPort, serverWorks, tempDir } from './testing/helpers.js';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

async function waitFor<T>(check: () => T | Promise<T>, what: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const textOf = (result: { content: unknown }) =>
  (result.content as { type: string; text: string }[])[0]?.text ?? '';

describe.skipIf(!serverWorks || !existsSync(BIN))('openboard mcp over stdio', () => {
  it('starts a background server, serves the tools, and brings the server back', async () => {
    const root = await tempDir();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, 'mcp', '--root', root],
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('board_apply');

      const outline = await client.callTool({ name: 'board_outline', arguments: {} });
      expect(outline.isError).toBeFalsy();
      expect(textOf(outline)).toContain(`Board main ${JSON.stringify(path.basename(root))}`);
      expect(stderr).toContain('starting the board server');

      const first = await findRunningServer(root);
      expect(first).not.toBeNull();
      expect(first?.pid).not.toBe(process.pid);

      const applied = await client.callTool({
        name: 'board_apply',
        arguments: {
          ops: [
            { op: 'add_node', ref: 'a', node: { type: 'task', title: 'First' } },
            { op: 'add_node', ref: 'b', node: { type: 'task', title: 'Second' } },
            { op: 'add_edge', edge: { type: 'depends_on', source: '$b', target: '$a' } },
          ],
        },
      });
      expect(textOf(applied)).toMatch(/^Applied: added 2 nodes, 1 edge/);
      await waitFor(
        () => existsSync(path.join(root, '.openboard/main.board.json')),
        'the board file',
      );

      // The server goes away; the next call starts a new one and succeeds.
      expect(await stopCommand(captureIo(root), { root })).toBe(0);
      const read = await client.callTool({ name: 'board_read', arguments: { detail: 'titles' } });
      expect(read.isError).toBeFalsy();
      expect(textOf(read)).toContain('"Second"');
      const second = await findRunningServer(root);
      expect(second?.pid).not.toBe(first?.pid);
    } finally {
      await client.close();
      await stopCommand(captureIo(root), { root });
    }
    expect(await findRunningServer(root)).toBeNull();
  }, 60_000);
});

describe.skipIf(!serverWorks)('openboard start', () => {
  it('serves MCP over HTTP at /mcp and describes itself at /api/info', async () => {
    const root = await tempDir();
    let shutdown: (signal: string) => void = () => {};
    const io = captureIo(root);
    io.shutdown = () =>
      new Promise<string>((resolve) => {
        shutdown = resolve;
      });
    let ready: (url: string) => void = () => {};
    const started = new Promise<string>((resolve) => {
      ready = resolve;
    });
    const done = startCommand(io, { root, port: randomPort(), open: false, onReady: ready });
    const url = await Promise.race([started, done.then(() => '')]);
    expect(url).not.toBe('');
    const client = new Client({ name: 'http-agent', version: '1.0.0' });
    try {
      expect(io.out()).toContain(`  MCP over HTTP   ${url}/mcp\n`);
      expect(io.out()).toContain(
        `  MCP over stdio  ${process.execPath} ${BIN} mcp --root ${root}\n`,
      );

      const info = (await (await fetch(`${url}/api/info`)).json()) as Record<string, unknown>;
      expect(info).toMatchObject({
        root,
        projectName: path.basename(root),
        url,
        mcp: {
          httpUrl: `${url}/mcp`,
          stdio: { command: process.execPath, args: [BIN, 'mcp', '--root', root] },
        },
      });

      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
      const applied = await client.callTool({
        name: 'board_apply',
        arguments: { ops: [{ op: 'add_node', node: { type: 'note', title: 'Over HTTP' } }] },
      });
      expect(textOf(applied)).toMatch(/^Applied: added 1 node/);
      const board = (await (await fetch(`${url}/api/boards/main`)).json()) as {
        nodes: Record<string, { createdBy: string }>;
      };
      expect(Object.values(board.nodes).map((node) => node.createdBy)).toEqual(['http-agent']);
    } finally {
      await client.close();
      shutdown('SIGTERM');
      expect(await done).toBe(0);
    }
  });
});
