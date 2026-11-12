/**
 * Review and history from the terminal: pending proposals and decisions on
 * them, the history of applied changes, and undo. All of it is working state
 * kept by the running server, so these commands need one.
 */
import type { Decision, Proposal, UndoRequest } from '@openboard/core';
import type { OpenBoardClient } from '@openboard/sdk';
import { CliError } from '../lib/errors.js';
import { type CliIo, println } from '../lib/io.js';
import { resolveRoot } from '../lib/project.js';
import { openSession } from '../lib/store.js';
import { printTable } from '../lib/table.js';
import { defaultBoardId } from './export.js';

export interface Live {
  client: OpenBoardClient;
  board: string;
}

/** A client for the running server and the board to use; a clear error when no server runs. */
export async function live(
  io: CliIo,
  root: string | undefined,
  board: string | undefined,
  what: string,
): Promise<Live> {
  const dir = resolveRoot(io, root);
  const session = await openSession(io, dir);
  if (!session.client) {
    throw new CliError(
      `${what} needs the running server, and none is running for ${dir}; start it with \`openboard start\``,
    );
  }
  return { client: session.client, board: board ?? (await defaultBoardId(session.store)) };
}

// ── Proposals ────────────────────────────────────────────────────────────────

export interface ProposalsOptions {
  root?: string;
  json?: boolean;
  /** Also list decided and withdrawn proposals. */
  all?: boolean;
}

/** List pending proposals (or all kept ones), item by item. */
export async function proposalsCommand(
  io: CliIo,
  board: string | undefined,
  options: ProposalsOptions = {},
): Promise<number> {
  const { client, board: id } = await live(io, options.root, board, 'Reviewing proposals');
  const result = await client.proposals(id, {
    status: options.all ? 'all' : 'pending',
    maxTokens: 50_000,
  });
  if (options.json) {
    println(io.stdout, JSON.stringify(result.proposals, null, 2));
    return 0;
  }
  println(io.stdout, result.text);
  if (result.proposals.some((p) => p.status === 'pending')) {
    println(io.stdout);
    println(
      io.stdout,
      'Decide with: openboard accept <id> [--items 0,2] [--note <text>], or openboard reject <id> [--note <text>]',
    );
  }
  return 0;
}

export interface DecideOptions {
  root?: string;
  note?: string;
  /** Item indexes to decide, comma-separated; default: every pending item. */
  items?: string;
  json?: boolean;
}

function parseItems(value: string): number[] {
  const items = value.split(',').map((part) => part.trim());
  const numbers = items.map(Number);
  if (items.some((part) => part === '') || numbers.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new CliError(`--items ${value}: give item numbers separated by commas, like 0,2`);
  }
  return numbers;
}

function printDecision(io: CliIo, proposal: Proposal): void {
  println(io.stdout, `Proposal ${proposal.id} is now ${proposal.status.replace('_', ' ')}.`);
  printTable(io.stdout, proposal.items, [
    { header: 'ITEM', value: (item) => `#${item.index}`, right: true },
    { header: 'STATUS', value: (item) => item.status },
    {
      header: 'CHANGE',
      value: (item) => (item.conflict ? `${item.summary} (${item.conflict})` : item.summary),
    },
  ]);
}

/** Accept or reject a proposal, in whole or in part. */
export async function decideCommand(
  io: CliIo,
  action: Decision['action'],
  proposalId: string,
  board: string | undefined,
  options: DecideOptions = {},
): Promise<number> {
  const decision: Decision = { action };
  if (options.items !== undefined) decision.items = parseItems(options.items);
  if (options.note !== undefined) decision.note = options.note;
  const { client, board: id } = await live(
    io,
    options.root,
    board,
    action === 'accept' ? 'Accepting a proposal' : 'Rejecting a proposal',
  );
  const proposal = await client.decideProposal(id, proposalId, decision);
  if (options.json) println(io.stdout, JSON.stringify(proposal, null, 2));
  else printDecision(io, proposal);
  return 0;
}

// ── History and undo ─────────────────────────────────────────────────────────

export interface HistoryCommandOptions {
  root?: string;
  limit?: number;
  actor?: string;
  json?: boolean;
}

/** The most recent batches of changes, newest first. */
export async function historyCommand(
  io: CliIo,
  board: string | undefined,
  options: HistoryCommandOptions = {},
): Promise<number> {
  const { client, board: id } = await live(io, options.root, board, 'History');
  const result = await client.history(id, {
    limit: options.limit ?? 20,
    maxTokens: 50_000,
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
  });
  if (options.json) {
    println(io.stdout, JSON.stringify(result.batches, null, 2));
    return 0;
  }
  if (result.batches.length === 0) {
    println(io.stdout, `No history${options.actor ? ` by ${options.actor}` : ''} on ${id}.`);
    return 0;
  }
  printTable(io.stdout, result.batches, [
    { header: 'BATCH', value: (b) => b.id },
    { header: 'AT', value: (b) => b.at },
    { header: 'ACTOR', value: (b) => b.actor },
    { header: 'SOURCE', value: (b) => b.source },
    { header: 'SUMMARY', value: (b) => b.summary },
    {
      header: 'NOTES',
      value: (b) =>
        [
          b.reason ? JSON.stringify(b.reason) : '',
          b.proposalId ? `from ${b.proposalId}` : '',
          b.undoes ? `undoes ${b.undoes}` : '',
          b.undoneBy ? `undone by ${b.undoneBy}` : '',
        ]
          .filter(Boolean)
          .join('; '),
    },
  ]);
  return 0;
}

export interface UndoCommandOptions {
  root?: string;
  /** Undo this actor's most recent batch (or all of them with `all`) instead of one batch. */
  actor?: string;
  all?: boolean;
  json?: boolean;
}

/**
 * Undo one batch (`openboard undo <batchId> [board]`), or an actor's most
 * recent batch or all of them (`openboard undo --actor <id> [--all] [board]`).
 */
export async function undoCommand(
  io: CliIo,
  args: string[],
  options: UndoCommandOptions = {},
): Promise<number> {
  let request: UndoRequest;
  let board: string | undefined;
  if (options.actor !== undefined) {
    if (args.length > 1) {
      throw new CliError(
        'with --actor, name at most the board: openboard undo --actor <id> [board]',
      );
    }
    board = args[0];
    request = { actorId: options.actor, scope: options.all ? 'all' : 'last' };
  } else {
    if (options.all) throw new CliError('--all needs --actor <id>');
    const [batchId, named, ...rest] = args;
    if (batchId === undefined) {
      throw new CliError(
        'name a batch (openboard undo <batchId> [board]; see openboard history), or an actor (openboard undo --actor <id> [--all])',
      );
    }
    if (rest.length > 0) throw new CliError('too many arguments: openboard undo <batchId> [board]');
    board = named;
    request = { batchId };
  }
  const { client, board: id } = await live(io, options.root, board, 'Undo');
  const result = await client.undo(id, request);
  if (options.json) println(io.stdout, JSON.stringify(result, null, 2));
  else println(io.stdout, result.text);
  return 0;
}
