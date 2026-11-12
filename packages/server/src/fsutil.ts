/**
 * Small filesystem helpers shared by the stores. Every write the server makes
 * goes through `writeFileAtomic`, so a crash mid-write leaves either the old
 * file or the new one, never a truncated mix.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Write to a temp file next to `file`, then rename it over `file`. With
 * `mode` (such as `0o600` for secrets), the temp file is created with it, so
 * the content is never readable by others, not even for a moment.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    if (options.mode === undefined) await writeFile(temp, data);
    else {
      await writeFile(temp, data, { mode: options.mode });
      // The umask may have taken bits away, never added any; set it exactly.
      await chmod(temp, options.mode);
    }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** File contents, or null when the file does not exist. */
export async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}

/**
 * Create `.openboard/.local/` with a `.gitignore` that ignores everything in
 * it, so runtime state (server.json, document history, the change feed)
 * never ends up in a commit.
 */
export async function ensureLocalDir(localDir: string): Promise<void> {
  await mkdir(localDir, { recursive: true });
  const ignore = path.join(localDir, '.gitignore');
  const current = await readIfExists(ignore);
  if (current?.toString('utf8') !== '*\n') await writeFileAtomic(ignore, '*\n');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
