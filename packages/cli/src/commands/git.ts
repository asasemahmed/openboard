/**
 * Boards in git: a merge driver that merges board files by meaning (never
 * conflict markers), a textconv that makes `git diff` readable, and the
 * commands that set both up and take them down again.
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Board,
  type MergeSide,
  mergeBoards,
  parseBoard,
  renderConflicts,
  serializeBoard,
} from '@openboard/core';
import { fullText, outlineText } from '../exporters.js';
import { CliError, isNodeError } from '../lib/errors.js';
import { git, gitTopLevel } from '../lib/git.js';
import { type CliIo, println } from '../lib/io.js';
import { shellQuote } from '../lib/mcp.js';
import { cliBinPath, resolveRoot } from '../lib/project.js';

/** The pattern the attributes apply to, relative to the project root. */
export const BOARD_PATTERN = '.openboard/*.board.json';
export const MERGE_ATTRIBUTE = `${BOARD_PATTERN} merge=openboard`;
export const DIFF_ATTRIBUTE = `${BOARD_PATTERN} diff=openboard`;
export const MERGE_NAME = 'OpenBoard board merge';

/** This install's command for git: absolute node and bin paths, shell-quoted for git's shell. */
function command(...args: string[]): string {
  return [process.execPath, cliBinPath(), ...args].map(shellQuote).join(' ');
}

export function mergeDriverLine(): string {
  return `${command('merge-driver')} %O %A %B %P`;
}

export function textconvLine(): string {
  return command('textconv');
}

// ── merge-driver ─────────────────────────────────────────────────────────────

export interface MergeDriverOptions {
  /** Exit 1 when the merge had to decide something, so git marks the file as conflicted. */
  strict?: boolean;
  /** Which side wins a conflict. Default `ours`. */
  prefer?: MergeSide;
}

async function readSide(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

function parseSide(text: string, side: string, name: string): Board {
  try {
    return parseBoard(text);
  } catch (error) {
    throw new CliError(
      `cannot merge ${name}: ${side} does not parse (${error instanceof Error ? error.message : String(error)}); the file was left as it is`,
    );
  }
}

/** Where the report of a merge goes: `.openboard/.local/last-merge.txt` next to the board file. */
function reportFile(cwd: string, boardPath: string | undefined): string | undefined {
  if (!boardPath) return undefined;
  const dir = path.dirname(path.resolve(cwd, boardPath));
  return path.basename(dir) === '.openboard'
    ? path.join(dir, '.local', 'last-merge.txt')
    : undefined;
}

/**
 * What git calls with `%O %A %B %P`. The merged board is written to `ours`. It
 * is always a valid board: conflicts are resolved (in favour of `prefer`,
 * keeping edits over deletions) and reported, never left as markers. So the
 * exit code is 0 unless `strict`, which exits 1 when something was decided,
 * for teams that want git to stop and have a person look.
 */
export async function mergeDriverCommand(
  io: CliIo,
  basePath: string,
  oursPath: string,
  theirsPath: string,
  boardPath: string | undefined,
  options: MergeDriverOptions = {},
): Promise<number> {
  const name = boardPath ?? oursPath;
  const [baseText, oursText, theirsText] = await Promise.all([
    readSide(path.resolve(io.cwd, basePath)),
    readSide(path.resolve(io.cwd, oursPath)),
    readSide(path.resolve(io.cwd, theirsPath)),
  ]);
  if (oursText === null)
    throw new CliError(`cannot merge ${name}: our version ${oursPath} is missing`);
  if (theirsText === null) {
    throw new CliError(`cannot merge ${name}: their version ${theirsPath} is missing`);
  }
  const ours = parseSide(oursText, 'our version', name);
  const theirs = parseSide(theirsText, 'their version', name);
  const base =
    baseText === null || baseText.trim() === ''
      ? null
      : parseSide(baseText, 'the common ancestor', name);

  const result = mergeBoards(base, ours, theirs, { prefer: options.prefer ?? 'ours' });
  const target = path.resolve(io.cwd, oursPath);
  const temp = `${target}.openboard-merge.tmp`;
  await writeFile(temp, serializeBoard(result.board));
  await rename(temp, target);

  if (result.clean) return 0;
  const report = renderConflicts(result.conflicts);
  io.stderr.write(`openboard: ${name}: ${report}`);
  const file = reportFile(io.cwd, boardPath);
  if (file) {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const ignore = path.join(path.dirname(file), '.gitignore');
      if (!existsSync(ignore)) await writeFile(ignore, '*\n');
      await appendFile(file, `== ${name} (${new Date().toISOString()}) ==\n${report}\n`);
    } catch {
      // The report on stderr stands.
    }
  }
  return options.strict ? 1 : 0;
}

// ── textconv ─────────────────────────────────────────────────────────────────

/**
 * A board file as stable, readable text for `git diff`: the outline, then
 * every node in full. A file that does not parse is printed as it is.
 */
export async function textconvCommand(io: CliIo, file: string): Promise<number> {
  const text = await readFile(path.resolve(io.cwd, file), 'utf8');
  let board: Board;
  try {
    board = parseBoard(text);
  } catch {
    io.stdout.write(text);
    return 0;
  }
  io.stdout.write(`${outlineText(board)}\n\n${fullText(board)}\n`);
  return 0;
}

// ── setup, status, remove ────────────────────────────────────────────────────

export interface GitSetupOptions {
  root?: string;
  /** Write the git settings to the global configuration instead of the repository's. */
  global?: boolean;
  /** Also set up readable diffs (textconv). */
  diff?: boolean;
  json?: boolean;
}

interface Repo {
  root: string;
  top: string;
  attributes: string;
  scope: '--global' | '--local';
}

async function repo(io: CliIo, options: GitSetupOptions): Promise<Repo> {
  const root = resolveRoot(io, options.root);
  const top = await gitTopLevel(io, root);
  if (!top) throw new CliError(`${root} is not in a git repository`);
  return {
    root,
    top,
    attributes: path.join(root, '.gitattributes'),
    scope: options.global ? '--global' : '--local',
  };
}

async function readLines(file: string): Promise<string[] | null> {
  try {
    return (await readFile(file, 'utf8')).split('\n');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Add `wanted` lines to `.gitattributes` that are not there yet; never touch the others. */
async function addAttributes(file: string, wanted: string[]): Promise<string[]> {
  const lines = (await readLines(file)) ?? [];
  const present = new Set(lines.map((line) => line.trim()));
  const missing = wanted.filter((line) => !present.has(line));
  if (missing.length === 0) return [];
  const text = lines.join('\n');
  const prefix = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  await writeFile(file, `${prefix}${missing.join('\n')}\n`);
  return missing;
}

/** Remove exactly `unwanted` lines; delete the file when nothing else is left in it. */
async function removeAttributes(file: string, unwanted: string[]): Promise<string[]> {
  const lines = await readLines(file);
  if (!lines) return [];
  const drop = new Set(unwanted);
  const removed = lines.filter((line) => drop.has(line.trim())).map((line) => line.trim());
  if (removed.length === 0) return [];
  const kept = lines.filter((line) => !drop.has(line.trim()));
  const text = kept.join('\n');
  if (text.trim() === '') await rm(file);
  else await writeFile(file, text.endsWith('\n') ? text : `${text}\n`);
  return removed;
}

async function getConfig(io: CliIo, r: Repo, key: string): Promise<string | undefined> {
  const result = await git(io, r.top, ['config', r.scope, '--get', key]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function setConfig(io: CliIo, r: Repo, key: string, value: string): Promise<void> {
  const result = await git(io, r.top, ['config', r.scope, key, value]);
  if (result.code !== 0) throw new CliError(`git config ${key} failed: ${result.stderr.trim()}`);
}

async function unsetConfig(io: CliIo, r: Repo, key: string): Promise<boolean> {
  return (await git(io, r.top, ['config', r.scope, '--unset', key])).code === 0;
}

export interface GitStatusReport {
  repository: string;
  attributes: { merge: boolean; diff: boolean };
  mergeDriver: string | null;
  textconv: string | null;
  /** True when the configured commands run this install. */
  current: { merge: boolean; diff: boolean };
}

export async function gitStatus(
  io: CliIo,
  options: GitSetupOptions = {},
): Promise<GitStatusReport> {
  const r = await repo(io, options);
  const lines = new Set(((await readLines(r.attributes)) ?? []).map((line) => line.trim()));
  // What git will actually use: any scope.
  const any = async (key: string) => {
    const result = await git(io, r.top, ['config', '--get', key]);
    return result.code === 0 ? result.stdout.trim() : null;
  };
  const mergeDriver = await any('merge.openboard.driver');
  const textconv = await any('diff.openboard.textconv');
  return {
    repository: r.top,
    attributes: { merge: lines.has(MERGE_ATTRIBUTE), diff: lines.has(DIFF_ATTRIBUTE) },
    mergeDriver,
    textconv,
    current: {
      merge: mergeDriver === mergeDriverLine(),
      diff: textconv === textconvLine(),
    },
  };
}

/** Set up the merge driver (and with `diff`, readable diffs). Safe to run again. */
export async function gitSetupCommand(io: CliIo, options: GitSetupOptions = {}): Promise<number> {
  const r = await repo(io, options);
  const wanted = options.diff ? [MERGE_ATTRIBUTE, DIFF_ATTRIBUTE] : [MERGE_ATTRIBUTE];
  const added = await addAttributes(r.attributes, wanted);
  await setConfig(io, r, 'merge.openboard.name', MERGE_NAME);
  await setConfig(io, r, 'merge.openboard.driver', mergeDriverLine());
  if (options.diff) await setConfig(io, r, 'diff.openboard.textconv', textconvLine());
  const where = options.global
    ? 'your global git configuration'
    : "this repository's git configuration";
  const rel = path.relative(io.cwd, r.attributes) || r.attributes;
  println(
    io.stdout,
    added.length
      ? `Added to ${rel}:\n${added.map((line) => `  ${line}`).join('\n')}`
      : `${rel} already has the OpenBoard ${options.diff ? 'lines' : 'line'}.`,
  );
  println(
    io.stdout,
    `Set the OpenBoard merge driver${options.diff ? ' and textconv' : ''} in ${where}.`,
  );
  println(
    io.stdout,
    `Commit ${rel} so everyone's git uses the driver once they run \`openboard git setup\` too.`,
  );
  return 0;
}

/** Print whether the merge driver and readable diffs are set up. */
export async function gitStatusCommand(io: CliIo, options: GitSetupOptions = {}): Promise<number> {
  const report = await gitStatus(io, options);
  if (options.json) {
    println(io.stdout, JSON.stringify(report, null, 2));
    return 0;
  }
  const state = (attribute: boolean, value: string | null, current: boolean) => {
    if (!attribute && !value) return 'not set up';
    if (!attribute) return 'configured, but .gitattributes does not use it';
    if (!value)
      return '.gitattributes uses it, but it is not configured (run `openboard git setup`)';
    return current ? 'set up' : `set up, but runs another install: ${value}`;
  };
  println(io.stdout, `Repository: ${report.repository}`);
  println(
    io.stdout,
    `Merge driver:   ${state(report.attributes.merge, report.mergeDriver, report.current.merge)}`,
  );
  println(
    io.stdout,
    `Readable diffs: ${state(report.attributes.diff, report.textconv, report.current.diff)}`,
  );
  return 0;
}

/** Undo what setup added: the two `.gitattributes` lines and the git settings. Nothing else. */
export async function gitRemoveCommand(io: CliIo, options: GitSetupOptions = {}): Promise<number> {
  const r = await repo(io, options);
  const removed = await removeAttributes(r.attributes, [MERGE_ATTRIBUTE, DIFF_ATTRIBUTE]);
  const unset = [];
  for (const key of ['merge.openboard.name', 'merge.openboard.driver', 'diff.openboard.textconv']) {
    if (await unsetConfig(io, r, key)) unset.push(key);
  }
  if (removed.length === 0 && unset.length === 0) {
    println(io.stdout, 'Nothing to remove: the OpenBoard merge driver is not set up here.');
    return 0;
  }
  if (removed.length) println(io.stdout, `Removed from .gitattributes: ${removed.join(', ')}`);
  if (unset.length) println(io.stdout, `Unset: ${unset.join(', ')}`);
  return 0;
}
