import open from 'open';
import { type CliIo, println } from './io.js';

/** Open `url` in the browser. A failure is a warning, never fatal. */
export async function openBrowser(io: CliIo, url: string): Promise<void> {
  try {
    if (io.openUrl) await io.openUrl(url);
    else await open(url);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    println(io.stderr, `openboard: could not open a browser (${reason}); visit ${url}`);
  }
}

/** The app URL that shows one board. */
export function boardUrl(base: string, boardId: string | undefined): string {
  if (boardId === undefined) return base;
  return new URL(`/b/${encodeURIComponent(boardId)}`, base).toString();
}

/** Resolves with the signal name on the first SIGINT or SIGTERM. */
export function waitForSignal(): Promise<string> {
  return new Promise((resolve) => {
    const handler = (name: NodeJS.Signals) => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
      resolve(name);
    };
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
  });
}
