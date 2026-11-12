/**
 * Commands against a real server. Skipped while `startServer` is not
 * implemented in this build; they run as soon as it is.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { newBoardCommand } from './commands/boards.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';
import { findRunningServer } from './lib/server.js';
import { captureIo, randomPort, serverWorks, tempDir } from './testing/helpers.js';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

/** Run `startCommand` in this process until the returned `stop` is called. */
async function startInProcess(root: string) {
  let shutdown: (signal: string) => void = () => {};
  const io = captureIo(root);
  io.shutdown = () =>
    new Promise<string>((resolve) => {
      shutdown = resolve;
    });
  let ready: (url: string) => void = () => {};
  const url = new Promise<string>((resolve) => {
    ready = resolve;
  });
  const done = startCommand(io, { root, port: randomPort(), open: false, onReady: ready });
  done.catch(() => {});
  const result = await Promise.race([url, done.then(() => '')]);
  if (!result) throw new Error(`start exited early: ${io.err()}`);
  return {
    io,
    url: result,
    stop: async () => {
      shutdown('SIGTERM');
      return done;
    },
  };
}

describe.skipIf(!serverWorks)('with a running server', () => {
  it('start creates the main board, status and new go through the server, then it closes', async () => {
    const root = await tempDir();
    const server = await startInProcess(root);
    try {
      expect(server.io.out()).toContain(`OpenBoard is running at ${server.url}`);
      expect(server.io.out()).toContain('Connect an agent');

      const status = captureIo(root);
      await statusCommand(status, { root, json: true });
      const report = JSON.parse(status.out());
      expect(report.running).toBe(true);
      expect(report.url).toBe(server.url);
      expect(report.boards.map((b: { id: string }) => b.id)).toEqual(['main']);

      const created = captureIo(root);
      await newBoardCommand(created, 'Second', { root });
      expect(created.out()).toBe('Created board second\n');

      const again = captureIo(root);
      await statusCommand(again, { root, json: true });
      expect(JSON.parse(again.out()).boards).toHaveLength(2);

      const second = captureIo(root);
      expect(await startCommand(second, { root, open: false })).toBe(0);
      expect(second.out()).toBe(`OpenBoard is already running at ${server.url}\n`);
    } finally {
      expect(await server.stop()).toBe(0);
    }
    expect(await findRunningServer(root)).toBeNull();
  });

  it.skipIf(!existsSync(BIN))(
    'stop ends a server started by the command',
    async () => {
      const root = await tempDir();
      const child: ChildProcess = spawn(
        process.execPath,
        [BIN, 'start', '--no-open', '--root', root, '--port', String(randomPort())],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      try {
        await new Promise<void>((resolve, reject) => {
          let out = '';
          child.stdout?.on('data', (chunk) => {
            out += String(chunk);
            if (out.includes('Press Ctrl+C')) resolve();
          });
          child.on('exit', (code) => reject(new Error(`server exited early with ${code}`)));
        });
        expect(await findRunningServer(root)).not.toBeNull();

        const io = captureIo(root);
        expect(await stopCommand(io, { root })).toBe(0);
        expect(io.out()).toMatch(/^Stopped OpenBoard \(pid \d+\)\.\n$/);
        expect(await exited).toBe(0);
        expect(await findRunningServer(root)).toBeNull();
      } finally {
        child.kill('SIGKILL');
      }
    },
    20_000,
  );
});

describe('stop without a server', () => {
  it('says so and succeeds', async () => {
    const root = await tempDir();
    const io = captureIo(root);
    expect(await stopCommand(io, { root })).toBe(0);
    expect(io.out()).toBe('OpenBoard is not running.\n');
  });
});
