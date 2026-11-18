import { boardUrl, openBrowser } from '../lib/browser.js';
import { type CliIo, println } from '../lib/io.js';
import { resolveRoot } from '../lib/project.js';
import { findRunningServer } from '../lib/server.js';

export interface OpenOptions {
  root?: string;
  board?: string;
}

/** Open the running project server's board in the browser. */
export async function openCommand(io: CliIo, options: OpenOptions = {}): Promise<number> {
  const root = resolveRoot(io, options.root);
  const running = await findRunningServer(root);
  if (!running) {
    println(io.stderr, 'OpenBoard is not running. Start one with: openboard start');
    return 1;
  }
  const url = boardUrl(running.url, options.board);
  println(io.stdout, `Opening ${url}`);
  await openBrowser(io, url);
  return 0;
}
