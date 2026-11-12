/** Running an agent CLI as a child process: output capture, timeout and abort, MCP config files. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { McpConnection } from '../types.js';

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when the run was stopped by the signal or the timeout. */
  killed: boolean;
}

/** Spawn without a shell, collect output, and stop the child on abort (TERM, then KILL). */
export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    timeoutMs?: number;
    stdin?: string;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv | undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const stop = () => {
      if (killed || child.exitCode !== null) return;
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 5000).unref();
    };
    const timer = options.timeoutMs !== undefined ? setTimeout(stop, options.timeoutMs) : undefined;
    if (options.signal?.aborted) stop();
    options.signal?.addEventListener('abort', stop, { once: true });
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      resolve({ code, signal, stdout, stderr, killed });
    };
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      finish(null, null);
    });
    child.on('close', finish);
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin ?? '');
  });
}

/** The `mcpServers` JSON most agent CLIs read, with the board server as `openboard`. */
export function mcpConfigJson(mcp: McpConnection): string {
  const server =
    'url' in mcp
      ? { type: 'http', url: mcp.url }
      : { type: 'stdio', command: mcp.command, args: mcp.args };
  return `${JSON.stringify({ mcpServers: { openboard: server } }, null, 2)}\n`;
}

/** Write the MCP config to its own temp directory, outside the project; returns the path and a remover. */
export async function writeMcpConfig(
  mcp: McpConnection,
): Promise<{ file: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'openboard-evals-mcp-'));
  const file = path.join(dir, 'mcp.json');
  await writeFile(file, mcpConfigJson(mcp));
  return { file, remove: () => rm(dir, { recursive: true, force: true }) };
}

export function tail(text: string, lines = 5): string {
  return text.trim().split('\n').slice(-lines).join(' | ');
}
