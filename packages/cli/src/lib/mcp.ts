/**
 * What the MCP side of the CLI shares: the command that launches the stdio
 * server, a background server that is started on demand, and a `BoardApi`
 * that brings that server back once if it disappears mid-session.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type Actor,
  type ApplyRequest,
  type ApplyResult,
  type Board,
  type BoardApi,
  type BoardSummary,
  type ChangesOptions,
  type ChangesResult,
  type CreateBoardInput,
  type LayoutRequest,
  type LayoutResult,
  OpenBoardError,
  type Outline,
  type OutlineOptions,
  type ReadQuery,
  type ReadResult,
  type SelectionResult,
} from '@openboard/core';
import { connect, type OpenBoardClient } from '@openboard/sdk';
import { CliError } from './errors.js';
import { type CliIo, println } from './io.js';
import { cliBinPath } from './project.js';
import { findRunningServer, type ServerInfo } from './server.js';

export interface Launch {
  command: string;
  args: string[];
}

/** The stdio MCP server for `root`, with absolute paths so it works from any directory. */
export function mcpLaunch(root: string): Launch {
  return { command: process.execPath, args: [cliBinPath(), 'mcp', '--root', root] };
}

const SAFE_ARG = /^[A-Za-z0-9_/.:=@%+,-]+$/;

/** A POSIX shell word for `arg`. */
export function shellQuote(arg: string): string {
  return SAFE_ARG.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellCommand(launch: Launch): string {
  return [launch.command, ...launch.args].map(shellQuote).join(' ');
}

export const START_TIMEOUT_MS = 15_000;
const POLL_MS = 100;

/**
 * The server running for `root`, starting one in the background when there
 * is none: a detached `openboard start --no-open` that outlives this process.
 */
export async function ensureServer(
  root: string,
  io: Pick<CliIo, 'stderr'>,
  timeoutMs = START_TIMEOUT_MS,
): Promise<ServerInfo> {
  const running = await findRunningServer(root);
  if (running) return running;

  println(io.stderr, `openboard: starting the board server for ${root}`);
  let failure: string | undefined;
  try {
    const child = spawn(process.execPath, [cliBinPath(), 'start', '--no-open', '--root', root], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', (error) => {
      failure = error.message;
    });
    child.unref();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await findRunningServer(root);
    if (info) {
      println(io.stderr, `openboard: board server running at ${info.url}`);
      return info;
    }
    if (failure !== undefined) throw new CliError(`could not start the board server: ${failure}`);
    if (Date.now() >= deadline) {
      throw new CliError(
        `the board server did not start within ${Math.round(timeoutMs / 1000)} s; run \`openboard start --root ${shellQuote(root)}\` to see why`,
      );
    }
    await sleep(POLL_MS);
  }
}

/** `fn` with concurrent calls sharing one run. */
export function shared<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= fn().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

function isUnavailable(error: unknown): boolean {
  return error instanceof OpenBoardError && error.code === 'unavailable';
}

/**
 * A `BoardApi` over HTTP that survives the server going away: when a call
 * fails because the server cannot be reached, the server is ensured again and
 * the call is retried once against it.
 *
 * It wraps every method of the client rather than listing them, so a method
 * added to `BoardApi` is covered without touching this file. Every client it
 * makes carries `session`, so the server sees one agent session throughout.
 */
export function reconnectingApi(
  actor: Actor,
  server: ServerInfo,
  ensure: () => Promise<ServerInfo>,
  session?: string,
): BoardApi {
  const open = (url: string) => connect({ url, actor, ...(session ? { session } : {}) });
  let client: OpenBoardClient = open(server.url);

  const call = async (name: string | symbol, args: unknown[]): Promise<unknown> => {
    // The client is fully typed; indexing it by a runtime method name is not.
    const invoke = (target: OpenBoardClient) =>
      (Reflect.get(target, name) as (...a: unknown[]) => Promise<unknown>).apply(target, args);
    try {
      return await invoke(client);
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      let info: ServerInfo;
      try {
        info = await ensure();
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        throw new OpenBoardError('unavailable', message);
      }
      client = open(info.url);
      return invoke(client);
    }
  };

  return new Proxy({ actor } as BoardApi, {
    get(target, name) {
      if (name === 'actor') return target.actor;
      if (typeof Reflect.get(client, name) !== 'function') return undefined;
      return (...args: unknown[]) => call(name, args);
    },
  });
}
