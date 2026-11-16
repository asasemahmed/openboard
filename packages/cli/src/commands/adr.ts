/**
 * `openboard adr`: write a board's decision cards into a folder as
 * Architecture Decision Records, one Markdown file each. Core's `planAdrs`
 * decides what goes where from the board and the files already there; this
 * command only reads the folder and writes the files it names.
 */
import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type AdrAction, type AdrExistingFile, planAdrs } from '@openboard-dev/core';
import { CliError } from '../lib/errors.js';
import { type CliIo, println } from '../lib/io.js';
import { resolveRoot } from '../lib/project.js';
import { openSession } from '../lib/store.js';
import { defaultBoardId } from './export.js';

export interface AdrOptions {
  root?: string;
  /** The ADR folder, relative to the working directory. Default: `docs/adr` in the project root. */
  out?: string;
  /** Say what would be written; write nothing. */
  dryRun?: boolean;
}

/** Larger files are not ADRs this command wrote; they are numbered but not read. */
const MAX_READ = 1024 * 1024;

const WORDS: Record<AdrAction, string> = {
  create: 'new',
  update: 'updated',
  unchanged: 'unchanged',
};

/** Every entry of the folder; the text only of regular Markdown files. */
async function readFolder(dir: string): Promise<AdrExistingFile[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new CliError(`${dir} is not a folder`);
    }
    throw error;
  }
  const files: AdrExistingFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
      files.push({ name: entry.name });
      continue;
    }
    const buffer = await readFile(path.join(dir, entry.name));
    files.push(
      buffer.length > MAX_READ
        ? { name: entry.name }
        : { name: entry.name, text: buffer.toString('utf8') },
    );
  }
  return files;
}

/** The file `name` inside `dir`, or an error when it would be anywhere else. */
function inside(dir: string, name: string): string {
  const file = path.resolve(dir, name);
  if (path.dirname(file) !== dir || name !== path.basename(file)) {
    throw new CliError(`refusing to write ${name}: it is not a file name inside ${dir}`);
  }
  return file;
}

/** Write through a temporary file and a rename, so a link in the folder is replaced, never followed. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await writeFile(temp, text, { flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Write the decision cards of a board as ADR files. */
export async function adrCommand(
  io: CliIo,
  boardId: string | undefined,
  options: AdrOptions = {},
): Promise<number> {
  const root = resolveRoot(io, options.root);
  const dir =
    options.out !== undefined ? path.resolve(io.cwd, options.out) : path.join(root, 'docs', 'adr');
  const { store } = await openSession(io, root);
  const board = await store.getBoard(boardId ?? (await defaultBoardId(store)));
  const plan = planAdrs(board, await readFolder(dir));
  for (const warning of plan.warnings) println(io.stderr, `warning: ${warning}`);

  const count = (action: AdrAction) => plan.files.filter((f) => f.action === action).length;
  const changed = count('create') + count('update');
  const shown = (name: string) => path.relative(io.cwd, path.join(dir, name)) || name;
  if (plan.files.length === 0) {
    println(io.stdout, `No decision cards on board ${board.id}.`);
  }
  if (!options.dryRun && changed > 0) await mkdir(dir, { recursive: true });
  for (const file of plan.files) {
    if (!options.dryRun && file.action !== 'unchanged') {
      await writeAtomic(inside(dir, file.name), file.text);
    }
    println(io.stdout, `${WORDS[file.action].padEnd(10)} ${shown(file.name)}`);
  }
  for (const file of plan.kept) {
    println(
      io.stdout,
      `${'kept'.padEnd(10)} ${shown(file.name)} (its card is no longer a decision)`,
    );
  }

  const summary = `${count('create')} new, ${count('update')} updated, ${count('unchanged')} unchanged`;
  const where = path.relative(io.cwd, dir) || '.';
  if (options.dryRun) {
    println(io.stdout, `Dry run: ${summary}. Nothing was written.`);
  } else if (plan.files.length > 0) {
    println(
      io.stdout,
      `Wrote ${changed} file${changed === 1 ? '' : 's'} to ${where} (${summary}).`,
    );
  }
  return 0;
}
