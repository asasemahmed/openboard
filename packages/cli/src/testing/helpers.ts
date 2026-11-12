/** Shared helpers for the CLI tests. Not part of the published build. */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Board, emptyBoard } from '@openboard/core';
import { afterEach } from 'vitest';
import type { CliIo } from '../lib/io.js';
import { startServer } from '../lib/server.js';

function isNotImplemented(error: unknown): boolean {
  return error instanceof Error && error.message === 'not implemented';
}

export interface CapturedIo extends CliIo {
  out(): string;
  err(): string;
}

export function captureIo(cwd: string, env: Record<string, string | undefined> = {}): CapturedIo {
  let out = '';
  let err = '';
  return {
    stdout: { write: (text: string) => (out += text), isTTY: false },
    stderr: { write: (text: string) => (err += text), isTTY: false },
    cwd,
    env,
    openUrl: async () => {},
    out: () => out,
    err: () => err,
  };
}

const temps: string[] = [];

/** A fresh, empty directory removed after the test. */
export async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'openboard-cli-')));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export function randomPort(): number {
  return 20_000 + Math.floor(Math.random() * 20_000);
}

/**
 * Whether `startServer` works in this build. Live-server tests are skipped
 * until it does, and run automatically from then on.
 */
export const serverWorks: boolean = await (async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openboard-probe-'));
  try {
    const server = await startServer({ root, port: randomPort() });
    await server.close();
    return true;
  } catch (error) {
    if (isNotImplemented(error)) return false;
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
})();

const T = '2026-01-02T03:04:05.000Z';

/** A small board with a frame, three nodes inside or outside it, and two edges. */
export function sampleBoard(): Board {
  const board = emptyBoard({ id: 'main', name: 'Launch', description: 'Ship it' }, new Date(T));
  const by = { createdBy: 'ada', createdAt: T, updatedBy: 'ada', updatedAt: T };
  board.actors.ada = { id: 'ada', kind: 'human', name: 'Ada' };
  board.nodes = {
    f_plan: { id: 'f_plan', type: 'frame', title: 'Plan', ...by },
    n_api: {
      id: 'n_api',
      type: 'task',
      title: 'Build the API',
      status: 'in_progress',
      parent: 'f_plan',
      body: 'Routes and errors.',
      tags: ['backend'],
      ...by,
    },
    n_docs: {
      id: 'n_docs',
      type: 'task',
      title: 'Write docs',
      status: 'todo',
      parent: 'f_plan',
      ...by,
    },
    n_risk: { id: 'n_risk', type: 'risk', title: 'Scope creep', ...by },
  };
  board.edges = {
    e_1: { id: 'e_1', type: 'depends_on', source: 'n_docs', target: 'n_api', ...by },
    e_2: { id: 'e_2', type: 'relates_to', source: 'n_risk', target: 'f_plan', ...by },
  };
  return board;
}
