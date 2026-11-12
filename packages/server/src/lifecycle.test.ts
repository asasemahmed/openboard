import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProjectRoot, findRunningServer, projectPaths } from './paths.js';
import { removeRoot, startTestServer, tempRoot } from './testing.js';
import type { OpenBoardServer } from './types.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function root(): Promise<string> {
  const dir = await tempRoot();
  cleanup.push(() => removeRoot(dir));
  return dir;
}

async function start(dir: string, opts: { port?: number } = {}): Promise<OpenBoardServer> {
  const server = await startTestServer(dir, opts);
  cleanup.push(() => server.close());
  return server;
}

describe('lifecycle', () => {
  it('writes server.json while running and removes it on close', async () => {
    const dir = await root();
    const server = await start(dir);
    const file = projectPaths(dir).serverInfo;
    const info = JSON.parse(await readFile(file, 'utf8'));
    expect(info).toEqual(server.info);
    expect(info).toMatchObject({ pid: process.pid, root: dir, url: server.url });
    expect(server.info.port).toBeGreaterThan(0);
    await server.close();
    expect(existsSync(file)).toBe(false);
    // close() resolves only once the port is free again.
    await expect(listenOn(server.info.port)).resolves.toBeUndefined();
  });

  it('finds a live server and clears a stale record', async () => {
    const dir = await root();
    const server = await start(dir);
    expect(await findRunningServer(dir)).toEqual(server.info);

    const other = await root();
    const paths = projectPaths(other);
    await mkdir(paths.local, { recursive: true });
    // A pid that is certainly not running.
    await writeFile(
      paths.serverInfo,
      JSON.stringify({ ...server.info, pid: 2 ** 22 + 7, root: other }),
    );
    expect(await findRunningServer(other)).toBeNull();
    expect(existsSync(paths.serverInfo)).toBe(false);

    // A live pid whose url answers for a different root is stale too.
    await writeFile(paths.serverInfo, JSON.stringify({ ...server.info, root: other }));
    expect(await findRunningServer(other)).toBeNull();
    expect(existsSync(paths.serverInfo)).toBe(false);
  });

  it('refuses a second server for the same root', async () => {
    const dir = await root();
    const server = await start(dir);
    await expect(start(dir)).rejects.toMatchObject({ code: 'conflict' });
    await expect(start(dir)).rejects.toThrow(server.url);
  });

  it('falls back to the next port when the preferred one is taken', async () => {
    const blocker = createServer();
    const port = await new Promise<number>((resolve) =>
      blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as { port: number }).port)),
    );
    cleanup.push(() => new Promise((resolve) => blocker.close(() => resolve())));
    const server = await start(await root(), { port });
    expect(server.info.port).toBeGreaterThan(port);
    expect(server.info.port).toBeLessThanOrEqual(port + 20);
    const health = await fetch(`${server.url}/api/health`);
    expect(health.status).toBe(200);
  });

  it('finds the project root from a nested directory', async () => {
    const dir = await root();
    const nested = path.join(dir, 'a', 'b');
    await mkdir(nested, { recursive: true });
    await mkdir(path.join(dir, '.git'));
    expect(findProjectRoot(nested)).toBe(dir);
    await mkdir(path.join(dir, 'a', '.openboard'));
    expect(findProjectRoot(nested)).toBe(path.join(dir, 'a'));
    expect(() => projectPaths(dir).boardFile('../escape')).toThrow(/invalid board id/);
  });

  it('restarts cleanly on the same root after close', async () => {
    const dir = await root();
    const first = await startTestServer(dir);
    await first.api({ id: 'a', kind: 'agent', name: 'A' }).createBoard({ name: 'Keep' });
    await first.close();
    const second = await start(dir);
    const boards = await second.api({ id: 'a', kind: 'agent', name: 'A' }).listBoards();
    expect(boards.map((b) => b.id)).toEqual(['keep']);
  });
});

function listenOn(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
}
