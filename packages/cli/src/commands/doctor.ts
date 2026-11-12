import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { connect } from '@openboard/sdk';
import { type CliIo, println } from '../lib/io.js';
import { type AppLocation, cliActor, locateApp, resolveRoot } from '../lib/project.js';
import { findRunningServer, projectPaths } from '../lib/server.js';
import { readBoardFiles } from '../lib/store.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  status: CheckStatus;
  label: string;
  /** How to fix it, for warnings and failures. */
  hint?: string;
}

export interface DoctorOptions {
  root?: string;
  json?: boolean;
  /** Overrides for tests. */
  nodeVersion?: string;
  app?: AppLocation;
}

const MIN_NODE_MAJOR = 22;

/** The MCP entry point loads and builds a server with its tools. */
async function mcpCheck(): Promise<Check> {
  try {
    const mcp = await import('@openboard/mcp');
    mcp.createMcpServer({
      resolveApi: () => {
        throw new Error('not connected');
      },
    });
    return { status: 'ok', label: `MCP server loads (${mcp.TOOL_NAMES.length} tools)` };
  } catch (error) {
    return {
      status: 'fail',
      label: `MCP server does not load: ${error instanceof Error ? error.message : String(error)}`,
      hint: 'reinstall openboard, or run `pnpm build` in a checkout',
    };
  }
}

function run(command: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 5000 }, (error, stdout) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, out: String(stdout).trim() });
    });
  });
}

async function gitCheck(root: string, local: string): Promise<Check | undefined> {
  const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], root);
  if (inside.code !== 0 || inside.out !== 'true') return undefined;
  const probe = path.relative(root, path.join(local, 'server.json'));
  const ignored = await run('git', ['check-ignore', '-q', '--no-index', probe], root);
  return ignored.code === 0
    ? { status: 'ok', label: 'Runtime state in .openboard/.local is ignored by git' }
    : {
        status: 'fail',
        label: '.openboard/.local is not ignored by git',
        hint: 'add ".openboard/.local/" to .gitignore, or run `openboard init`',
      };
}

/** Run every check. Never throws for a failed check; it becomes a `fail` line. */
export async function runChecks(io: CliIo, options: DoctorOptions = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const major = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { status: 'ok', label: `Node.js ${nodeVersion}` }
      : {
          status: 'fail',
          label: `Node.js ${nodeVersion} is too old`,
          hint: `install Node.js ${MIN_NODE_MAJOR} or newer`,
        },
  );

  let root: string;
  try {
    root = resolveRoot(io, options.root);
    checks.push({ status: 'ok', label: `Project root: ${root}` });
  } catch (error) {
    checks.push({
      status: 'fail',
      label: `Project root not found: ${error instanceof Error ? error.message : String(error)}`,
      hint: 'run from inside your project, or pass --root <dir>',
    });
    return checks;
  }

  const paths = projectPaths(root);
  const initialized = existsSync(paths.dir) && statSync(paths.dir).isDirectory();
  checks.push(
    initialized
      ? { status: 'ok', label: '.openboard/ exists' }
      : {
          status: 'fail',
          label: `No .openboard directory in ${root}`,
          hint: 'run `openboard init`',
        },
  );

  if (initialized) {
    const files = await readBoardFiles(paths);
    if (files.length === 0) {
      checks.push({
        status: 'warn',
        label: 'No boards yet',
        hint: 'create one with `openboard new <name>`',
      });
    }
    for (const file of files) {
      const rel = path.relative(root, file.file);
      checks.push(
        file.problem === undefined
          ? { status: 'ok', label: `${rel} parses` }
          : {
              status: 'fail',
              label: `${rel}: ${file.problem}`,
              hint: 'fix the file by hand, or restore it from git',
            },
      );
    }
  }

  const app = options.app ?? locateApp();
  checks.push(
    app.built
      ? { status: 'ok', label: 'Web app is built' }
      : {
          status: 'fail',
          label: app.dir ? `Web app is not built (${app.dir})` : 'Web app package is missing',
          hint: 'run `pnpm build`',
        },
  );

  checks.push(await mcpCheck());

  const server = await findRunningServer(root);
  if (!server) {
    checks.push({
      status: 'warn',
      label: 'Server is not running',
      hint: 'start it with `openboard start`',
    });
  } else {
    try {
      const health = await connect({
        url: server.url,
        actor: cliActor(io.env),
        timeoutMs: 3000,
      }).health();
      checks.push(
        health.ok
          ? { status: 'ok', label: `Server is running at ${server.url} (pid ${health.pid})` }
          : {
              status: 'fail',
              label: `Server at ${server.url} reports it is not healthy`,
              hint: 'restart it: `openboard stop`, then `openboard start`',
            },
      );
    } catch (error) {
      checks.push({
        status: 'fail',
        label: `Server is recorded (pid ${server.pid}) but not reachable: ${error instanceof Error ? error.message : String(error)}`,
        hint: 'restart it: `openboard stop`, then `openboard start`',
      });
    }
  }

  const git = await gitCheck(root, paths.local);
  if (git) checks.push(git);
  return checks;
}

const MARK: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

/** Check the installation and the project. Exits 1 when any check fails. */
export async function doctorCommand(io: CliIo, options: DoctorOptions = {}): Promise<number> {
  const checks = await runChecks(io, options);
  const failed = checks.some((check) => check.status === 'fail');
  if (options.json) {
    println(io.stdout, JSON.stringify({ ok: !failed, checks }, null, 2));
    return failed ? 1 : 0;
  }
  for (const check of checks) {
    println(io.stdout, `${MARK[check.status]}  ${check.label}`);
    if (check.hint && check.status !== 'ok') println(io.stdout, `      fix: ${check.hint}`);
  }
  const failures = checks.filter((check) => check.status === 'fail').length;
  println(io.stdout);
  println(
    io.stdout,
    failed ? `${failures} check${failures === 1 ? '' : 's'} failed.` : 'Everything looks good.',
  );
  return failed ? 1 : 0;
}
