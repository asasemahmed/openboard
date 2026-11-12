/**
 * Project settings: `.openboard/config.json` (see `ProjectConfigSchema` in
 * core). The file is meant to be committed. Without it the defaults apply.
 *
 * The file is re-read when it changes on disk (a checkout, an editor), the
 * same way board files are. A file that does not parse is reported and the
 * last good settings stay in effect until it parses again.
 */
import { stat } from 'node:fs/promises';
import {
  DEFAULT_CONFIG,
  OpenBoardError,
  type ProjectConfig,
  ProjectConfigSchema,
  parseConfig,
  serializeConfig,
} from '@openboard/core';
import { errorMessage, isErrno, readIfExists, sha256, writeFileAtomic } from './fsutil.js';

export class ConfigStore {
  private current: ProjectConfig = DEFAULT_CONFIG;
  private problem: string | undefined;
  private knownHash: string | null = null;
  private seenStat: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** The settings in effect. */
  get config(): ProjectConfig {
    return this.current;
  }

  /** Why the config file is being ignored, when it does not parse. */
  get error(): string | undefined {
    return this.problem;
  }

  /** Read the file for the first time. */
  load(): Promise<void> {
    return this.enqueue(() => this.reload());
  }

  /** The file changed on disk (or might have). */
  fileChanged(): Promise<void> {
    return this.enqueue(() => this.reload());
  }

  /** Re-read when the file's identity, size or mtime changed; a backstop for missed watcher events. */
  async poll(): Promise<void> {
    if ((await statKey(this.file)) !== this.seenStat) await this.fileChanged();
  }

  /** Validate, write atomically and take effect. Throws `invalid_request`. */
  async set(config: ProjectConfig): Promise<ProjectConfig> {
    const parsed = ProjectConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new OpenBoardError(
        'invalid_request',
        `invalid config: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        parsed.error.issues,
      );
    }
    const text = serializeConfig(parsed.data);
    let failure: unknown;
    await this.enqueue(async () => {
      try {
        this.knownHash = sha256(text);
        await writeFileAtomic(this.file, text);
        this.seenStat = await statKey(this.file);
        this.current = parsed.data;
        this.problem = undefined;
      } catch (error) {
        failure = error;
      }
    });
    if (failure !== undefined) {
      throw new OpenBoardError(
        'unavailable',
        `could not write ${this.file}: ${errorMessage(failure)}`,
      );
    }
    return this.current;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task).catch((error: unknown) => {
      this.log(`config: ${errorMessage(error)}`);
    });
    this.queue = next;
    return next;
  }

  private async reload(): Promise<void> {
    this.seenStat = await statKey(this.file);
    const bytes = await readIfExists(this.file);
    if (bytes === null) {
      if (this.knownHash !== null) this.log(`${this.file} was removed; using the default settings`);
      this.knownHash = null;
      this.current = DEFAULT_CONFIG;
      this.problem = undefined;
      return;
    }
    const text = bytes.toString('utf8');
    const hash = sha256(text);
    if (hash === this.knownHash) return;
    this.knownHash = hash;
    try {
      this.current = parseConfig(text);
      if (this.problem !== undefined) this.log(`${this.file} parses again`);
      this.problem = undefined;
    } catch (error) {
      this.problem = errorMessage(error);
      this.log(
        `${this.file} is ignored until it is fixed; the last good settings stay in effect: ${this.problem}`,
      );
    }
  }
}

async function statKey(file: string): Promise<string | null> {
  try {
    const st = await stat(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}
