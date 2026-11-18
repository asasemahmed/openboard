import { describe, expect, it } from 'vitest';
import { startServer } from '../lib/server.js';
import { captureIo, tempDir } from '../testing/helpers.js';
import { openCommand } from './open.js';

describe('open', () => {
  it('tells you how to start a server and exits with 1 when none is running', async () => {
    const dir = await tempDir();
    const io = captureIo(dir);

    expect(await openCommand(io)).toBe(1);
    expect(io.err()).toContain('openboard start');
    expect(io.out()).toBe('');
  });

  it('opens the running server board in the browser', async () => {
    const dir = await tempDir();
    const server = await startServer({ root: dir, port: 0 });
    try {
      const opened: string[] = [];
      const io = captureIo(dir);
      io.openUrl = async (url) => {
        opened.push(url);
      };

      expect(await openCommand(io)).toBe(0);
      expect(opened).toEqual([server.url]);
      expect(io.out()).toContain(server.url);

      opened.length = 0;
      expect(await openCommand(io, { board: 'plan' })).toBe(0);
      expect(opened).toEqual([`${server.url}/b/plan`]);
    } finally {
      await server.close();
    }
  });
});
