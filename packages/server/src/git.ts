/**
 * The git history of board files. Git runs through `execFile` (never a
 * shell) with a timeout, in the project root, and only with revisions that
 * passed `RevisionSchema` and were resolved to a commit id first, so nothing
 * a caller sends can be read as an option.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { OpenBoardError, type Revision, RevisionSchema } from '@openboard/core';

const GIT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 64 * 1024 * 1024;

interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export class Git {
  constructor(private readonly root: string) {}

  /** Run git; resolves with its exit code. Rejects only when git cannot be started at all. */
  private run(args: string[]): Promise<GitOutput> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd: this.root,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT,
          encoding: 'utf8',
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
        },
        (error, stdout, stderr) => {
          if (error && typeof (error as { code?: unknown }).code !== 'number') {
            reject(error);
            return;
          }
          const code = error ? ((error as { code?: number }).code ?? 1) : 0;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }

  /** Like `run`, but a missing git or a timeout counts as "not a repository". */
  private async tryRun(args: string[]): Promise<GitOutput | null> {
    try {
      return await this.run(args);
    } catch {
      return null;
    }
  }

  /** The path git uses for a file, relative to the project root, with a `./` so it stays relative. */
  private spec(file: string): string {
    return `./${path.relative(this.root, file).split(path.sep).join('/')}`;
  }

  /** True when the project is in a work tree and `file` is tracked. */
  async tracked(file: string): Promise<boolean> {
    const result = await this.tryRun(['ls-files', '--error-unmatch', '--', this.spec(file)]);
    return result?.code === 0;
  }

  /** Commits that touched `file`, newest first. */
  async log(file: string, limit: number): Promise<Revision[]> {
    const result = await this.tryRun([
      'log',
      `--max-count=${limit}`,
      '--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1e',
      '--',
      this.spec(file),
    ]);
    if (!result || result.code !== 0) return [];
    return result.stdout
      .split('\x1e')
      .map((record) => record.trim())
      .filter((record) => record !== '')
      .map((record) => {
        const [rev = '', short = '', at = '', author = '', subject = ''] = record.split('\x1f');
        return { rev, short, at, author, subject };
      });
  }

  /** True when the file on disk differs from HEAD. */
  async dirty(file: string): Promise<boolean> {
    const result = await this.tryRun(['diff', '--quiet', 'HEAD', '--', this.spec(file)]);
    return result?.code === 1;
  }

  /** The commit id `rev` names. Throws `invalid_request` for a malformed one, `not_found` when it names nothing. */
  async resolve(rev: string): Promise<string> {
    const parsed = RevisionSchema.safeParse(rev);
    if (!parsed.success) {
      throw new OpenBoardError('invalid_request', `invalid revision ${JSON.stringify(rev)}`);
    }
    const result = await this.tryRun([
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${parsed.data}^{commit}`,
    ]);
    const id = result?.code === 0 ? result.stdout.trim() : '';
    if (!/^[0-9a-f]{40,64}$/.test(id)) {
      throw new OpenBoardError('not_found', `no commit ${JSON.stringify(rev)} in this repository`);
    }
    return id;
  }

  /** The content of `file` at `rev`. Throws `not_found` when the commit or the file there does not exist. */
  async show(rev: string, file: string): Promise<string> {
    const id = await this.resolve(rev);
    const result = await this.tryRun(['show', `${id}:${this.spec(file)}`]);
    if (!result || result.code !== 0) {
      throw new OpenBoardError(
        'not_found',
        `${path.relative(this.root, file)} does not exist in revision ${rev}`,
      );
    }
    return result.stdout;
  }
}
