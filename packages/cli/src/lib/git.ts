/**
 * The few git calls the command line makes. Always `execFile` (no shell),
 * with the caller's environment so tests can isolate git's configuration.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { CliError } from './errors.js';
import type { CliIo } from './io.js';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git in `cwd`. Never throws for a non-zero exit; throws `CliError` when git is missing. */
export function git(io: Pick<CliIo, 'env'>, cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...io.env }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { code?: unknown }) | null;
        if (failure && failure.code === 'ENOENT') {
          reject(new CliError('git is not installed, or not on PATH', 2));
          return;
        }
        const code = failure ? (typeof failure.code === 'number' ? failure.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** The top of the git work tree containing `dir`, or undefined when it is not in one. */
export async function gitTopLevel(
  io: Pick<CliIo, 'env'>,
  dir: string,
): Promise<string | undefined> {
  const result = await git(io, dir, ['rev-parse', '--show-toplevel']);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/**
 * A revision as the user may write it (`HEAD`, `main`, `HEAD~2`, `origin/main`,
 * `v1.2`, a SHA, `main@{1}`), and nothing that git could read as an option or
 * a path.
 */
export function checkRev(rev: string): string {
  if (
    rev.length === 0 ||
    rev.length > 200 ||
    rev.startsWith('-') ||
    rev.includes('..') ||
    rev.includes(':') ||
    !/^[A-Za-z0-9._/~^@{}-]+$/.test(rev)
  ) {
    throw new CliError(
      `"${rev}" is not a revision this command accepts (use a branch, tag, commit or HEAD~n)`,
      2,
    );
  }
  return rev;
}

/** `file` relative to `top`, with forward slashes, as git names it in `<rev>:<path>`. */
export function gitPath(top: string, file: string): string {
  return path.relative(top, file).split(path.sep).join('/');
}

/**
 * The content of `file` at `rev`, or null when the file is not in that
 * revision. Throws `CliError` for an unknown revision.
 */
export async function showAt(
  io: Pick<CliIo, 'env'>,
  top: string,
  rev: string,
  file: string,
): Promise<string | null> {
  checkRev(rev);
  const verify = await git(io, top, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  if (verify.code !== 0) throw new CliError(`unknown revision "${rev}"`, 2);
  const result = await git(io, top, ['show', `${rev}:${gitPath(top, file)}`]);
  if (result.code === 0) return result.stdout;
  if (/does not exist|exists on disk, but not in/.test(result.stderr)) return null;
  throw new CliError(`git show ${rev}:${gitPath(top, file)} failed: ${result.stderr.trim()}`, 2);
}

/** Board ids with a file in `.openboard/` at `rev`. */
export async function boardIdsAt(
  io: Pick<CliIo, 'env'>,
  top: string,
  rev: string,
  dir: string,
): Promise<string[]> {
  checkRev(rev);
  const prefix = gitPath(top, dir);
  const result = await git(io, top, ['ls-tree', '--name-only', rev, '--', `${prefix}/`]);
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim().split('/').pop() ?? '')
    .filter((name) => name.endsWith('.board.json'))
    .map((name) => name.slice(0, -'.board.json'.length));
}

/** One commit that touched a file, as `revisions` reports it. */
export interface FileRevision {
  rev: string;
  short: string;
  at: string;
  author: string;
  subject: string;
}

/**
 * The commits that changed `file`, newest first, and whether the file on disk
 * differs from the last commit. `tracked` is false when git does not know it.
 */
export async function fileRevisions(
  io: Pick<CliIo, 'env'>,
  top: string,
  file: string,
  limit = 20,
): Promise<{ tracked: boolean; dirty: boolean; revisions: FileRevision[] }> {
  const rel = gitPath(top, file);
  const known = await git(io, top, ['ls-files', '--error-unmatch', '--', rel]);
  if (known.code !== 0) return { tracked: false, dirty: false, revisions: [] };
  const log = await git(io, top, [
    'log',
    `--max-count=${limit}`,
    '--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s',
    '--',
    rel,
  ]);
  const revisions = log.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [rev = '', short = '', at = '', author = '', subject = ''] = line.split('\x1f');
      return { rev, short, at, author, subject };
    });
  const status = await git(io, top, ['status', '--porcelain', '--', rel]);
  return { tracked: true, dirty: status.stdout.trim() !== '', revisions };
}
