import { setTimeout as sleep } from 'node:timers/promises';
import { CliError, isNodeError } from '../lib/errors.js';
import { type CliIo, println } from '../lib/io.js';
import { resolveRoot } from '../lib/project.js';
import { findRunningServer } from '../lib/server.js';

export interface StopOptions {
  root?: string;
  /** How long to wait after SIGTERM before sending SIGKILL. */
  timeoutMs?: number;
}

const POLL_MS = 100;
const KILL_WAIT_MS = 2000;

/** Send a signal; false when the process is already gone. */
function signal(pid: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') return false;
    if (isNodeError(error) && error.code === 'EPERM') {
      throw new CliError(`not permitted to stop the server (pid ${pid})`);
    }
    throw error;
  }
}

async function waitUntilStopped(root: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await findRunningServer(root)) === null) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/** Stop the server recorded for this project root. */
export async function stopCommand(io: CliIo, options: StopOptions = {}): Promise<number> {
  const root = resolveRoot(io, options.root);
  const info = await findRunningServer(root);
  if (!info) {
    println(io.stdout, 'OpenBoard is not running.');
    return 0;
  }
  if (info.pid === process.pid) {
    throw new CliError('the server for this root runs in this process; close it instead');
  }

  const timeoutMs = options.timeoutMs ?? 5000;
  if (signal(info.pid, 'SIGTERM') && !(await waitUntilStopped(root, timeoutMs))) {
    println(
      io.stderr,
      `openboard: the server (pid ${info.pid}) did not stop within ${timeoutMs / 1000}s; sending SIGKILL`,
    );
    if (signal(info.pid, 'SIGKILL') && !(await waitUntilStopped(root, KILL_WAIT_MS))) {
      throw new CliError(`could not stop the server (pid ${info.pid})`);
    }
  }
  println(io.stdout, `Stopped OpenBoard (pid ${info.pid}).`);
  return 0;
}
