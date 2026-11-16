/**
 * Cards that follow the work in git: a commit whose message says
 * `Closes card <id>` marks that card as done and records the commit on it, as
 * a `commit` link whose target is the short sha and the subject.
 *
 * `openboard git sync` reads recent commits (or a range, or what a git hook
 * just made) and applies them, through the running server when there is one
 * (as the `git` system actor, so the canvas updates live and the change is in
 * the history), otherwise to the board files. What was already applied is
 * worked out from the cards: a commit recorded on a card is never applied to
 * it again, so running it twice changes nothing. No other state is kept,
 * which keeps it right across branches, where each board file has its own.
 */
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Actor,
  applyOps,
  type Board,
  type BoardNode,
  IdSchema,
  LIMITS,
  type Link,
  type NodePatch,
  type Op,
  type OpError,
  serializeBoard,
} from '@openboard-dev/core';
import { connect, type OpenBoardClient } from '@openboard-dev/sdk';
import { CliError } from '../lib/errors.js';
import { checkRev, git, gitTopLevel } from '../lib/git.js';
import { type CliIo, println } from '../lib/io.js';
import { resolveRoot } from '../lib/project.js';
import { findRunningServer, type ProjectPaths, projectPaths } from '../lib/server.js';
import { readBoardFiles } from '../lib/store.js';

/** Who card changes made from commits are attributed to. */
export const GIT_ACTOR: Actor = { id: 'git', kind: 'system', name: 'git' };

/** How many commits on HEAD a sync without a range reads. */
export const RECENT_COMMITS = 100;

/** How long a call to the server may take from a git hook. */
const HOOK_TIMEOUT_MS = 5000;

/** The git hooks that run `git sync`; each reads only what it just brought in. */
export const SYNC_HOOKS = ['post-commit', 'post-merge'] as const;
export type SyncHook = (typeof SYNC_HOOKS)[number];

// ── Messages ─────────────────────────────────────────────────────────────────

const KEYWORD = /\b(?:closes|fixes|resolves)\s+(cards?)\s+/gi;
/** An id, optionally in backticks. Trailing `.` and `:` are punctuation, not part of it. */
const ID_TOKEN = /`?([A-Za-z0-9][A-Za-z0-9_.:-]*)`?/y;
/** Between two ids of a list: a comma, `and`, or both, then `card` or not. */
const SEPARATOR = /(?:\s*,\s*(?:and\s+)?|\s+and\s+)(card\s+)?/iy;

function readId(text: string, at: number): { id: string; end: number; last: boolean } | null {
  ID_TOKEN.lastIndex = at;
  const match = ID_TOKEN.exec(text);
  if (!match?.[1]) return null;
  const id = match[1].replace(/[.:]+$/, '');
  // `Closes card a. And card b` ends the list at the full stop.
  return { id, end: ID_TOKEN.lastIndex, last: id.length < match[1].length };
}

/**
 * The card ids a commit message closes, in order and without repeats:
 * `Closes card <id>`, `Fixes card <id>` or `Resolves card <id>`, in any case,
 * anywhere in the message. Several ids are written `Closes card a, card b`,
 * `Closes card a and card b`, or with `cards`: `Closes cards a, b and c`. A
 * word that is not a valid node id is skipped.
 */
export function parseClosedCards(message: string): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (IdSchema.safeParse(id).success && !ids.includes(id)) ids.push(id);
  };
  for (const match of message.matchAll(KEYWORD)) {
    const plural = match[1]?.toLowerCase() === 'cards';
    let next = readId(message, (match.index ?? 0) + match[0].length);
    while (next) {
      add(next.id);
      if (next.last) break;
      SEPARATOR.lastIndex = next.end;
      const separator = SEPARATOR.exec(message);
      if (!separator) break;
      // After `card`, a list goes on with `card <id>`; after `cards`, bare ids are enough.
      if (!plural && !separator[1]) break;
      next = readId(message, SEPARATOR.lastIndex);
    }
  }
  return ids;
}

// ── Commits ──────────────────────────────────────────────────────────────────

export interface Commit {
  sha: string;
  short: string;
  subject: string;
  message: string;
}

const FIELD = '\x1f';
const RECORD = '\x1e';

/** `[from]..[to]` or one revision, as `git log` takes it; checked like any revision. */
export function rangeArgs(range: string): string[] {
  if (range.includes('...')) {
    throw new CliError(`"${range}": use a range like main..HEAD (two dots), or one revision`, 2);
  }
  const parts = range.split('..');
  if (parts.length === 1) return [checkRev(range)];
  if (parts.length !== 2) throw new CliError(`"${range}" is not a revision range`, 2);
  const [from = '', to = ''] = parts;
  return [`${from ? checkRev(from) : 'HEAD'}..${to ? checkRev(to) : 'HEAD'}`];
}

async function readCommits(
  io: CliIo,
  top: string,
  revs: string[],
  limit?: number,
): Promise<Commit[]> {
  const result = await git(io, top, [
    'log',
    '--reverse',
    ...(limit ? [`--max-count=${limit}`] : []),
    `--format=%H${FIELD}%h${FIELD}%s${FIELD}%B${RECORD}`,
    ...revs,
    '--',
  ]);
  if (result.code !== 0) {
    throw new CliError(`git log ${revs.join(' ')} failed: ${result.stderr.trim()}`, 2);
  }
  // Oldest first. `--max-count` picks the newest commits before `--reverse` orders them.
  return result.stdout
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [sha = '', short = '', subject = '', message = ''] = record.split(FIELD);
      return { sha, short, subject, message };
    });
}

async function resolveCommit(io: CliIo, top: string, rev: string): Promise<string | undefined> {
  const result = await git(io, top, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

// ── What a commit does to a board ────────────────────────────────────────────

/** Where status makes sense: a task, or any node but a frame that already has a status. */
export function isCard(node: BoardNode): boolean {
  return node.type === 'task' || (node.type !== 'frame' && node.status !== undefined);
}

/** `LinkSchema` allows targets this long. */
const LINK_TARGET_MAX = 500;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The link that records `commit` on a card: the short sha, then the subject. */
export function commitLink(commit: Pick<Commit, 'short' | 'subject'>): Link {
  const subject = oneLine(commit.subject);
  const target = subject ? `${commit.short} ${subject}` : commit.short;
  return { kind: 'commit', target: target.slice(0, LINK_TARGET_MAX) };
}

/**
 * Whether `links` already record `commit`: a commit link whose sha is a prefix
 * of this one, or one with the same subject (the same commit after a rebase,
 * an amend or a cherry-pick).
 */
export function hasCommit(links: readonly Link[] | undefined, commit: Commit): boolean {
  const wanted = commitLink(commit).target.slice(commit.short.length + 1);
  return (links ?? []).some((link) => {
    if (link.kind !== 'commit') return false;
    const space = link.target.indexOf(' ');
    const sha = (space === -1 ? link.target : link.target.slice(0, space)).toLowerCase();
    if (/^[0-9a-f]{7,64}$/.test(sha) && commit.sha.startsWith(sha)) return true;
    return space !== -1 && wanted !== '' && link.target.slice(space + 1) === wanted;
  });
}

/** One card a sync changes, for the report. */
export interface CardChange {
  board: string;
  node: string;
  title: string;
  /** True when this sync moved the card to `done`. */
  closed: boolean;
  /** The commits recorded on it. */
  commits: string[];
}

export interface SyncPlan {
  /** One `update_node` per card, by board. */
  ops: Map<string, Op[]>;
  changes: CardChange[];
  warnings: string[];
}

/**
 * The changes `commits` make to `boards`. Pure: the same commits against
 * boards that already have them give an empty plan.
 */
export function planSync(boards: readonly Board[], commits: readonly Commit[]): SyncPlan {
  const warnings: string[] = [];
  const patches = new Map<string, { board: Board; node: BoardNode; patch: NodePatch }>();
  const changes = new Map<string, CardChange>();

  for (const commit of commits) {
    if (/^Revert "/.test(commit.subject)) continue;
    for (const id of parseClosedCards(commit.message)) {
      const found = boards.filter((board) => board.nodes[id]);
      if (found.length === 0) {
        warnings.push(`commit ${commit.short} closes card ${id}, which is on no board; ignored`);
        continue;
      }
      for (const board of found) {
        const key = `${board.id}\n${id}`;
        const entry = patches.get(key);
        const node = entry?.node ?? (board.nodes[id] as BoardNode);
        if (!isCard(node)) {
          warnings.push(
            `commit ${commit.short} closes ${id} on ${board.id}, a ${node.type} without a status; ignored`,
          );
          continue;
        }
        const links = entry?.patch.links ?? node.links ?? [];
        if (hasCommit(links, commit)) continue;
        const patch: NodePatch = { ...entry?.patch };
        if (node.status !== 'done') patch.status = 'done';
        if (links.length < LIMITS.linksPerNode) patch.links = [...links, commitLink(commit)];
        else {
          warnings.push(
            `card ${id} on ${board.id} has ${LIMITS.linksPerNode} links already; commit ${commit.short} is not recorded on it`,
          );
        }
        if (patch.status === undefined && patch.links === undefined) continue;
        patches.set(key, { board, node, patch });
        const change = changes.get(key) ?? {
          board: board.id,
          node: id,
          title: node.title,
          closed: false,
          commits: [],
        };
        if (patch.status === 'done') change.closed = true;
        change.commits.push(commit.short);
        changes.set(key, change);
      }
    }
  }

  const ops = new Map<string, Op[]>();
  for (const { board, node, patch } of patches.values()) {
    const list = ops.get(board.id) ?? [];
    list.push({ op: 'update_node', id: node.id, patch });
    ops.set(board.id, list);
  }
  return { ops, changes: [...changes.values()], warnings };
}

function reasonFor(changes: readonly CardChange[], board: string): string {
  const shas = [...new Set(changes.filter((c) => c.board === board).flatMap((c) => c.commits))];
  const reason = `Closed by commit${shas.length === 1 ? '' : 's'} ${shas.join(', ')}`;
  return reason.length <= 300 ? reason : `${reason.slice(0, 299)}…`;
}

// ── Where the boards are ─────────────────────────────────────────────────────

interface Target {
  boards(): Promise<Board[]>;
  /** Apply one board's operations; returns the errors when it was refused. */
  apply(board: string, ops: Op[], reason: string): Promise<OpError[] | 'proposed' | null>;
}

function serverTarget(client: OpenBoardClient): Target {
  return {
    boards: async () => {
      const list = await client.listBoards();
      return Promise.all(list.map((b) => client.getBoard(b.id)));
    },
    apply: async (board, ops, reason) => {
      const result = await client.apply(board, { ops, reason });
      if (result.status === 'invalid') return result.errors ?? [];
      return result.status === 'proposed' ? 'proposed' : null;
    },
  };
}

function fileTarget(io: CliIo, paths: ProjectPaths): Target {
  const read = new Map<string, Board>();
  return {
    boards: async () => {
      const boards: Board[] = [];
      for (const entry of await readBoardFiles(paths)) {
        if (entry.board) {
          boards.push(entry.board);
          read.set(entry.board.id, entry.board);
        } else println(io.stderr, `openboard: skipping ${entry.file}: ${entry.problem}`);
      }
      return boards;
    },
    apply: async (board, ops) => {
      const current = read.get(board);
      if (!current) return [{ index: 0, code: 'not_found', message: `no board ${board}` }];
      const outcome = applyOps(current, ops, { actor: GIT_ACTOR });
      if (!outcome.ok) return outcome.errors;
      const file = paths.boardFile(board);
      const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
      await writeFile(temp, serializeBoard(outcome.board));
      await rename(temp, file);
      return null;
    },
  };
}

// ── The command ──────────────────────────────────────────────────────────────

export interface GitSyncOptions {
  root?: string;
  /** Say what would change, and change nothing. */
  dryRun?: boolean;
  /**
   * Run from this git hook: read only the commits it brought in, print only
   * what changed and the warnings, and never fail (problems are printed, the
   * exit code is 0).
   */
  hook?: SyncHook;
}

/**
 * `openboard git sync [range]`: mark the cards that commits close as done.
 * Without a range, the last `RECENT_COMMITS` commits on HEAD.
 */
export async function gitSyncCommand(
  io: CliIo,
  range: string | undefined,
  options: GitSyncOptions = {},
): Promise<number> {
  if (!options.hook) return sync(io, range, options);
  try {
    return await sync(io, range, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    println(io.stderr, `openboard: git sync: ${message.split('\n')[0]}`);
    return 0;
  }
}

/** What a hook just brought in: the new commit (or a merge's other side), or what a merge or pull added. */
async function hookCommits(io: CliIo, top: string, hook: SyncHook): Promise<Commit[]> {
  if (hook === 'post-merge') {
    const before = await resolveCommit(io, top, 'ORIG_HEAD');
    return before ? readCommits(io, top, [`${before}..HEAD`]) : [];
  }
  const parent = await resolveCommit(io, top, 'HEAD^1');
  return parent ? readCommits(io, top, [`${parent}..HEAD`]) : readCommits(io, top, ['HEAD'], 1);
}

async function sync(io: CliIo, range: string | undefined, options: GitSyncOptions) {
  const quiet = options.hook !== undefined;
  const say = (line: string) => {
    if (!quiet) println(io.stdout, line);
  };
  if (range !== undefined && options.hook) throw new CliError('pass a range or --hook, not both');
  const root = resolveRoot(io, options.root);
  const paths = projectPaths(root);
  const top = await gitTopLevel(io, root);
  if (!top) throw new CliError(`${root} is not in a git repository`);

  let commits: Commit[];
  if (options.hook) commits = await hookCommits(io, top, options.hook);
  else if (range !== undefined) commits = await readCommits(io, top, rangeArgs(range));
  else if (!(await resolveCommit(io, top, 'HEAD'))) {
    say('No commits yet.');
    return 0;
  } else commits = await readCommits(io, top, ['HEAD'], RECENT_COMMITS);

  if (!commits.some((commit) => parseClosedCards(commit.message).length > 0)) {
    say(`No card to close in ${commits.length} commit${commits.length === 1 ? '' : 's'}.`);
    return 0;
  }

  const server = await findRunningServer(root);
  const target = server
    ? serverTarget(
        connect({
          url: server.url,
          actor: GIT_ACTOR,
          ...(options.hook ? { timeoutMs: HOOK_TIMEOUT_MS } : {}),
        }),
      )
    : fileTarget(io, paths);
  const plan = planSync(await target.boards(), commits);
  for (const warning of plan.warnings) println(io.stderr, `warning: ${warning}`);

  const describe = (change: CardChange) =>
    `card ${change.node} ${JSON.stringify(change.title)} on ${change.board} (${change.commits.join(', ')})`;
  if (plan.changes.length === 0) {
    say('Nothing to change: every card these commits close already records them.');
    return 0;
  }
  if (options.dryRun) {
    for (const change of plan.changes) {
      say(`Would ${change.closed ? 'close' : 'record the commit on'} ${describe(change)}.`);
    }
    say('Dry run: nothing was changed.');
    return 0;
  }

  let failed = false;
  for (const [board, ops] of plan.ops) {
    const outcome = await target.apply(board, ops, reasonFor(plan.changes, board));
    const changes = plan.changes.filter((change) => change.board === board);
    if (outcome === null) {
      for (const change of changes) {
        println(
          io.stdout,
          `${quiet ? 'openboard: ' : ''}${change.closed ? 'Closed' : 'Recorded the commit on'} ${describe(change)}.`,
        );
      }
    } else if (outcome === 'proposed') {
      println(io.stdout, `Sent the changes to ${board} for review.`);
    } else {
      failed = true;
      const lines = outcome.slice(0, 5).map((e) => `  ${e.message}`);
      println(io.stderr, `openboard: ${board} was not changed:\n${lines.join('\n')}`);
    }
  }
  return failed ? 1 : 0;
}
