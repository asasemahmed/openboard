/**
 * Code and git from the terminal: the board's links into the code and whether
 * that code changed, and the git history of a board file.
 */
import { CliError } from '../lib/errors.js';
import { fileRevisions, gitTopLevel } from '../lib/git.js';
import { type CliIo, println } from '../lib/io.js';
import { resolveRoot } from '../lib/project.js';
import { projectPaths } from '../lib/server.js';
import { openSession } from '../lib/store.js';
import { printTable } from '../lib/table.js';
import { defaultBoardId } from './export.js';
import { live } from './review.js';

export interface LinksOptions {
  root?: string;
  /** List every link, not only those whose code changed or is gone. */
  all?: boolean;
  json?: boolean;
}

/**
 * `openboard links [board]` lists links; `openboard links refresh <nodeId...> [board]`
 * or `openboard links refresh --all [board]` marks nodes as checked against the
 * code as it is now. With node ids, a last argument that names a board is the board.
 */
export async function linksCommand(
  io: CliIo,
  args: string[],
  options: LinksOptions = {},
): Promise<number> {
  if (args[0] === 'refresh') return refresh(io, args.slice(1), options);
  if (args.length > 1) throw new CliError('too many arguments: openboard links [board]');
  const { client, board } = await live(io, options.root, args[0], 'Checking code links');
  const result = await client.links(board, {
    maxTokens: 50_000,
    ...(options.all ? {} : { stale: true }),
  });
  if (options.json) println(io.stdout, JSON.stringify(result.links, null, 2));
  else {
    println(
      io.stdout,
      result.text.replace(
        'call refreshLinks for it to clear the mark.',
        'run `openboard links refresh <node id>` to clear the mark.',
      ),
    );
  }
  return 0;
}

async function refresh(io: CliIo, args: string[], options: LinksOptions): Promise<number> {
  let board: string | undefined;
  let nodeIds: string[] = [];
  const session = await live(io, options.root, undefined, 'Refreshing code links');
  if (options.all) {
    if (args.length > 1) throw new CliError('with --all, name at most the board');
    board = args[0];
  } else {
    if (args.length === 0) {
      throw new CliError(
        'name the nodes to refresh (openboard links refresh <node id...>), or pass --all',
      );
    }
    const boards = new Set((await session.client.listBoards()).map((b) => b.id));
    const last = args[args.length - 1] as string;
    if (args.length > 1 && boards.has(last)) {
      board = last;
      nodeIds = args.slice(0, -1);
    } else nodeIds = args;
  }
  const id = board ?? session.board;
  const result = await session.client.refreshLinks(id, options.all ? { all: true } : { nodeIds });
  if (result.status === 'invalid') {
    const lines = (result.errors ?? []).map((e) => `  ${e.message}`);
    throw new CliError(`nothing was refreshed:\n${lines.join('\n')}`);
  }
  const count = result.applied?.updatedNodes.length ?? 0;
  if (options.json) println(io.stdout, JSON.stringify(result, null, 2));
  else {
    println(
      io.stdout,
      count === 0
        ? 'Nothing to refresh: those links already match the code.'
        : `Refreshed the code links of ${count} node${count === 1 ? '' : 's'} on ${id}.`,
    );
  }
  return 0;
}

export interface RevisionsCommandOptions {
  root?: string;
  limit?: number;
  json?: boolean;
}

/** The git history of a board file: through the running server, or with git directly. */
export async function revisionsCommand(
  io: CliIo,
  boardArg: string | undefined,
  options: RevisionsCommandOptions = {},
): Promise<number> {
  const root = resolveRoot(io, options.root);
  const session = await openSession(io, root);
  const board = boardArg ?? (await defaultBoardId(session.store));
  const limit = options.limit ?? 20;
  let report: {
    tracked: boolean;
    dirty: boolean;
    revisions: Array<{ short: string; rev: string; at: string; author: string; subject: string }>;
  };
  if (session.client) {
    report = await session.client.revisions(board, { limit });
  } else {
    const top = await gitTopLevel(io, root);
    report = top
      ? await fileRevisions(io, top, projectPaths(root).boardFile(board), limit)
      : { tracked: false, dirty: false, revisions: [] };
  }
  if (options.json) {
    println(
      io.stdout,
      JSON.stringify(
        { board, tracked: report.tracked, dirty: report.dirty, revisions: report.revisions },
        null,
        2,
      ),
    );
    return 0;
  }
  if (!report.tracked) {
    println(
      io.stdout,
      `The file of board ${board} is not tracked by git, so it has no revisions yet.`,
    );
    return 0;
  }
  printTable(io.stdout, report.revisions, [
    { header: 'REV', value: (r) => r.short },
    { header: 'DATE', value: (r) => r.at },
    { header: 'AUTHOR', value: (r) => r.author },
    { header: 'SUBJECT', value: (r) => r.subject },
  ]);
  if (report.dirty) {
    println(
      io.stdout,
      `The board file has changes that are not committed (see openboard diff ${board}).`,
    );
  }
  return 0;
}
