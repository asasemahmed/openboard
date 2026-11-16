/**
 * `openboard check`: whether the boards still match the code, for CI and
 * pre-commit hooks. It reads the board files and the linked code directly and
 * never talks to a server. Exit codes: 0 when clean, 1 when something needs a
 * look, 2 on an error.
 */
import {
  type Board,
  checkBoardAgainstTypes,
  type LinkEntry,
  linkRangeLabel,
  type TypeWarning,
} from '@openboard-dev/core';
import { CliError } from '../lib/errors.js';
import { type CliIo, println } from '../lib/io.js';
import { resolveRoot } from '../lib/project.js';
import { checkCodeLinks, projectPaths } from '../lib/server.js';
import { readBoardFiles } from '../lib/store.js';
import { projectTypes } from './extend.js';

export interface CheckOptions {
  root?: string;
  json?: boolean;
  /** Check the code links (default true; `--no-links` turns it off). */
  links?: boolean;
  /** Check the nodes against their declared types (default true; `--no-types`). */
  types?: boolean;
}

export interface BoardCheck {
  board: string;
  /** Code links whose code changed (`stale`) or is gone (`missing`). Absent when not checked. */
  links?: LinkEntry[];
  /** Nodes that do not fit their declared type. Absent when not checked. */
  types?: TypeWarning[];
}

const isFinding = (entry: LinkEntry) => entry.state === 'stale' || entry.state === 'missing';

const countOf = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Check one board, or every board in `.openboard/`. Returns 0 (clean), 1 (findings) or 2. */
export async function checkCommand(
  io: CliIo,
  boardArg: string | undefined,
  options: CheckOptions = {},
): Promise<number> {
  try {
    return await run(io, boardArg, options);
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 2) throw error;
    throw new CliError(
      error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error),
      2,
    );
  }
}

async function run(
  io: CliIo,
  boardArg: string | undefined,
  options: CheckOptions,
): Promise<number> {
  const links = options.links !== false;
  const types = options.types !== false;
  if (!links && !types) throw new CliError('nothing to check: both checks are turned off', 2);
  const root = resolveRoot(io, options.root);
  const paths = projectPaths(root);

  let files = await readBoardFiles(paths);
  if (boardArg !== undefined) {
    files = files.filter((f) => f.id === boardArg);
    if (files.length === 0) throw new CliError(`no board "${boardArg}" in ${paths.dir}`, 2);
  } else if (files.length === 0) {
    throw new CliError(`no boards in ${paths.dir} (create one with: openboard init)`, 2);
  }
  const registry = types ? await projectTypes(root) : undefined;

  const reports: BoardCheck[] = [];
  const boards = new Map<string, Board>();
  for (const file of files) {
    if (!file.board) throw new CliError(`${file.file} does not parse: ${file.problem}`, 2);
    const board = file.board;
    boards.set(file.id, board);
    const report: BoardCheck = { board: file.id };
    if (links) report.links = (await checkCodeLinks(root, board)).filter(isFinding);
    if (registry) report.types = checkBoardAgainstTypes(board, registry);
    reports.push(report);
  }

  const clean = reports.every((r) => !r.links?.length && !r.types?.length);
  if (options.json) {
    println(io.stdout, JSON.stringify({ clean, boards: reports }, null, 2));
    return clean ? 0 : 1;
  }
  for (const report of reports) {
    for (const line of renderReport(report, boards.get(report.board) as Board)) {
      println(io.stdout, line);
    }
  }
  if (reports.some((r) => r.links?.length)) {
    println(
      io.stdout,
      'Check those nodes against the code as it is now, then clear the mark with `openboard links refresh <node id>` (with the server running).',
    );
  }
  if (reports.some((r) => r.types?.length)) {
    println(
      io.stdout,
      'Fix the nodes that do not fit their type, or the type in .openboard/config.json.',
    );
  }
  return clean ? 0 : 1;
}

function renderReport(report: BoardCheck, board: Board): string[] {
  const linkFindings = report.links ?? [];
  const typeFindings = report.types ?? [];
  if (linkFindings.length === 0 && typeFindings.length === 0) {
    const parts = [
      ...(report.links ? ['the code links match the code'] : []),
      ...(report.types ? ['every node fits its declared type'] : []),
    ];
    return [`Board ${report.board}: ${parts.join(', and ')}.`];
  }
  // By node, in id order: what changed in its code, then what does not fit its type.
  const byNode = new Map<string, string[]>();
  const add = (id: string, line: string) => {
    const lines = byNode.get(id) ?? [];
    lines.push(line);
    byNode.set(id, lines);
  };
  for (const entry of linkFindings) add(entry.nodeId, linkLine(entry));
  for (const warning of typeFindings) add(warning.nodeId, warning.message);
  const ids = [...byNode.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const summary = [
    ...(linkFindings.length
      ? [`${countOf(linkFindings.length, 'code link', 'code links')} out of date`]
      : []),
    ...(typeFindings.length
      ? [`${countOf(typeFindings.length, 'type problem', 'type problems')}`]
      : []),
  ].join(', ');
  const out = [
    `Board ${report.board}: ${countOf(ids.length, 'node needs', 'nodes need')} a look (${summary}):`,
  ];
  for (const id of ids) {
    const node = board.nodes[id];
    out.push(`  ${id} ${JSON.stringify(node?.title ?? '')} (${node?.type ?? 'unknown'})`);
    for (const line of byNode.get(id) ?? []) out.push(`    ${line}`);
  }
  return out;
}

/** One link as `openboard links` shows it: `#0 file src/a.ts:3-9 [stale]: content changed at lines 3-9`. */
function linkLine(entry: LinkEntry): string {
  const range = linkRangeLabel(entry.link).replace(/^lines? /, ':');
  const detail = entry.detail ? `: ${entry.detail}` : '';
  return `#${entry.index} ${entry.link.kind} ${entry.link.target}${range} [${entry.state}]${detail}`;
}
