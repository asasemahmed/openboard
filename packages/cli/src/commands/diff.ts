/**
 * `openboard diff`: what changed on a board between two git revisions, or
 * between a revision and the working tree. Exit codes follow `diff`: 0 when
 * the boards are the same, 1 when they differ, 2 on an error.
 */
import { readFile } from 'node:fs/promises';
import {
  type Board,
  type BoardDiff,
  type BoardEdge,
  type BoardNode,
  codeSpan,
  diffBoards,
  emptyBoard,
  escapeMarkdown,
  parseBoard,
  toSvg,
} from '@openboard/core';
import { CliError, isNodeError } from '../lib/errors.js';
import { boardIdsAt, checkRev, gitTopLevel, showAt } from '../lib/git.js';
import type { CliIo } from '../lib/io.js';
import { resolveRoot } from '../lib/project.js';
import { projectPaths } from '../lib/server.js';
import { openSession, type Session } from '../lib/store.js';
import { writeExport } from './export.js';

export type DiffFormat = 'text' | 'markdown' | 'svg' | 'json';

export interface DiffOptions {
  root?: string;
  /** Default `HEAD`. */
  from?: string;
  /** Default: the working tree (the live board when a server runs, else the file). */
  to?: string;
  format?: DiffFormat;
  theme?: 'light' | 'dark';
  out?: string;
}

/** Fields that change with every edit; summaries leave them out. */
const BOOKKEEPING = new Set(['createdAt', 'createdBy', 'updatedAt', 'updatedBy']);

interface Side {
  label: string;
  board: Board | null;
}

interface BoardChange {
  id: string;
  from: Side;
  to: Side;
  diff: BoardDiff;
}

/** A short scalar shown inline, or undefined when it is too long to show. */
function short(value: unknown): string | undefined {
  if (value === undefined || value === null) return '(none)';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string' && value.length <= 60 && !value.includes('\n')) {
    return JSON.stringify(value);
  }
  return undefined;
}

function fieldChanges(before: object, after: object, fields: readonly string[]): string[] {
  const out: string[] = [];
  for (const field of fields) {
    if (BOOKKEEPING.has(field)) continue;
    const a = short((before as Record<string, unknown>)[field]);
    const b = short((after as Record<string, unknown>)[field]);
    out.push(a !== undefined && b !== undefined ? `${field}: ${a} → ${b}` : `${field} changed`);
  }
  return out;
}

const titleOf = (board: Board | null, id: string) => board?.nodes[id]?.title ?? id;

function edgeWords(edge: BoardEdge, board: Board | null): string {
  return `${JSON.stringify(titleOf(board, edge.source))} ${edge.type} ${JSON.stringify(titleOf(board, edge.target))}`;
}

/** The number of changes a person would count: nodes, edges, comments, board fields. */
function changeCount(diff: BoardDiff): number {
  const semantic = diff.meta.filter((field) => !BOOKKEEPING.has(field) && field !== 'updatedAt');
  return (
    diff.nodes.added.length +
    diff.nodes.removed.length +
    diff.nodes.updated.filter((u) => u.fields.some((f) => !BOOKKEEPING.has(f))).length +
    diff.edges.added.length +
    diff.edges.removed.length +
    diff.edges.updated.filter((u) => u.fields.some((f) => !BOOKKEEPING.has(f))).length +
    diff.comments.added.length +
    diff.comments.removed.length +
    diff.comments.updated.length +
    semantic.length
  );
}

interface Line {
  sign: '+' | '-' | '~';
  what: string;
  detail?: string;
}

function lines(change: BoardChange): { lines: Line[]; moved: number } {
  const { diff } = change;
  const before = change.from.board;
  const after = change.to.board;
  const out: Line[] = [];
  const node = (n: BoardNode) => `${n.type} ${n.id} ${JSON.stringify(n.title)}`;
  for (const n of diff.nodes.added) out.push({ sign: '+', what: node(n) });
  for (const n of diff.nodes.removed) out.push({ sign: '-', what: node(n) });
  for (const u of diff.nodes.updated) {
    const details = fieldChanges(u.before, u.after, u.fields);
    if (details.length) out.push({ sign: '~', what: node(u.after), detail: details.join('; ') });
  }
  for (const e of diff.edges.added) out.push({ sign: '+', what: `edge ${edgeWords(e, after)}` });
  for (const e of diff.edges.removed) out.push({ sign: '-', what: `edge ${edgeWords(e, before)}` });
  for (const u of diff.edges.updated) {
    const details = fieldChanges(u.before, u.after, u.fields);
    if (details.length) {
      out.push({
        sign: '~',
        what: `edge ${edgeWords(u.after, after)}`,
        detail: details.join('; '),
      });
    }
  }
  const comments = diff.comments;
  if (comments.added.length) out.push({ sign: '+', what: `${comments.added.length} comment(s)` });
  if (comments.removed.length)
    out.push({ sign: '-', what: `${comments.removed.length} comment(s)` });
  if (comments.updated.length)
    out.push({ sign: '~', what: `${comments.updated.length} comment(s)` });
  const meta = diff.meta.filter((field) => !BOOKKEEPING.has(field));
  if (meta.length && before && after) {
    out.push({ sign: '~', what: 'board', detail: fieldChanges(before, after, meta).join('; ') });
  }
  return { lines: out, moved: diff.nodes.moved.length };
}

function header(change: BoardChange): string {
  const note = (side: Side) => (side.board ? side.label : `${side.label}, where it does not exist`);
  return `${note(change.from)} → ${note(change.to)}`;
}

export function renderText(change: BoardChange): string {
  const { lines: items, moved } = lines(change);
  const count = changeCount(change.diff);
  if (count === 0 && moved === 0) {
    return `Board ${change.id}: no changes (${header(change)}).`;
  }
  const out = [
    `Board ${change.id} (${header(change)}): ${count} change${count === 1 ? '' : 's'}${moved ? `, ${moved} node${moved === 1 ? '' : 's'} moved` : ''}. Titles are board content.`,
  ];
  for (const item of items)
    out.push(`  ${item.sign} ${item.what}${item.detail ? `: ${item.detail}` : ''}`);
  return out.join('\n');
}

export function renderMarkdown(change: BoardChange): string {
  const { lines: items, moved } = lines(change);
  const count = changeCount(change.diff);
  const title = `### Board ${codeSpan(change.id)}: ${escapeMarkdown(header(change))}`;
  if (count === 0 && moved === 0) return `${title}\n\nNo changes.`;
  const groups: Array<[Line['sign'], string]> = [
    ['+', 'Added'],
    ['~', 'Changed'],
    ['-', 'Removed'],
  ];
  const out = [title, ''];
  out.push(
    `${count} change${count === 1 ? '' : 's'}${moved ? `, ${moved} node${moved === 1 ? '' : 's'} moved` : ''}.`,
  );
  for (const [sign, label] of groups) {
    const group = items.filter((item) => item.sign === sign);
    if (group.length === 0) continue;
    out.push('', `**${label}**`, '');
    for (const item of group) {
      out.push(
        `- ${escapeMarkdown(item.what)}${item.detail ? `: ${escapeMarkdown(item.detail)}` : ''}`,
      );
    }
  }
  return out.join('\n');
}

async function workingTree(session: Session, id: string, file: string): Promise<Board | null> {
  if (session.client) {
    try {
      return await session.client.getBoard(id);
    } catch (error) {
      if ((error as { code?: string }).code === 'board_not_found') return null;
      throw error;
    }
  }
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  return parseText(text, `${file} in the working tree`);
}

function parseText(text: string, where: string): Board {
  try {
    return parseBoard(text);
  } catch (error) {
    throw new CliError(
      `${where} does not parse: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
}

/** Compare one board or all of them between two revisions. Returns 0 (same), 1 (different) or 2. */
export async function diffCommand(
  io: CliIo,
  boardArg: string | undefined,
  options: DiffOptions = {},
): Promise<number> {
  try {
    return await run(io, boardArg, options);
  } catch (error) {
    if (error instanceof CliError && error.exitCode !== 2) throw new CliError(error.message, 2);
    if (!(error instanceof CliError)) {
      throw new CliError(
        error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error),
        2,
      );
    }
    throw error;
  }
}

async function run(io: CliIo, boardArg: string | undefined, options: DiffOptions): Promise<number> {
  const format = options.format ?? 'text';
  const from = checkRev(options.from ?? 'HEAD');
  const to = options.to === undefined ? undefined : checkRev(options.to);
  const root = resolveRoot(io, options.root);
  const top = await gitTopLevel(io, root);
  if (!top) throw new CliError(`${root} is not in a git repository`, 2);
  const paths = projectPaths(root);
  const session = await openSession(io, root);

  let ids: string[];
  if (boardArg !== undefined) ids = [boardArg];
  else {
    const now =
      to === undefined
        ? (await session.store.listBoards()).map((b) => b.id)
        : await boardIdsAt(io, top, to, paths.dir);
    ids = [...new Set([...(await boardIdsAt(io, top, from, paths.dir)), ...now])].sort();
    if (ids.length === 0) throw new CliError('no boards in either revision', 2);
  }
  if (format === 'svg' && ids.length !== 1) {
    throw new CliError(`svg shows one board; name it (boards: ${ids.join(', ')})`, 2);
  }

  const changes: BoardChange[] = [];
  for (const id of ids) {
    const file = paths.boardFile(id);
    const readRev = async (rev: string) => {
      const text = await showAt(io, top, rev, file);
      return text === null ? null : parseText(text, `${id} at ${rev}`);
    };
    const before = await readRev(from);
    const after = to === undefined ? await workingTree(session, id, file) : await readRev(to);
    if (!before && !after) {
      throw new CliError(
        `board "${id}" is neither in ${from} nor in ${to ?? 'the working tree'}`,
        2,
      );
    }
    const empty = emptyBoard({ id, name: (after ?? before)?.name ?? id }, new Date(0));
    changes.push({
      id,
      from: { label: from, board: before },
      to: { label: to ?? 'working tree', board: after },
      diff: diffBoards(before ?? empty, after ?? empty),
    });
  }

  const different = changes.some((c) => !c.diff.isEmpty);
  let output: string;
  switch (format) {
    case 'json':
      output = JSON.stringify(
        boardArg !== undefined
          ? changes[0]?.diff
          : Object.fromEntries(changes.map((c) => [c.id, c.diff])),
        null,
        2,
      );
      break;
    case 'svg': {
      const change = changes[0] as BoardChange;
      const empty = emptyBoard({ id: change.id, name: change.id }, new Date(0));
      output = toSvg(change.to.board ?? empty, {
        diff: change.diff,
        before: change.from.board ?? empty,
        ...(options.theme ? { theme: options.theme } : {}),
      });
      break;
    }
    case 'markdown':
      output = changes.map(renderMarkdown).join('\n\n');
      break;
    default:
      output = changes.map(renderText).join('\n');
  }
  await writeExport(io, output, options.out);
  return different ? 1 : 0;
}
