import type { BoardSummary } from '@openboard/core';
import { type CliIo, println } from '../lib/io.js';
import { resolveRoot } from '../lib/project.js';
import { openSession } from '../lib/store.js';
import { printTable } from '../lib/table.js';

export interface BoardsOptions {
  root?: string;
  json?: boolean;
}

/** The board fields shown in listings. */
export type BoardRow = Pick<BoardSummary, 'id' | 'name' | 'nodeCount' | 'edgeCount' | 'updatedAt'>;

export function printBoards(io: CliIo, boards: readonly BoardRow[]): void {
  printTable(io.stdout, boards, [
    { header: 'ID', value: (b) => b.id },
    { header: 'NAME', value: (b) => b.name },
    { header: 'NODES', value: (b) => b.nodeCount, right: true },
    { header: 'EDGES', value: (b) => b.edgeCount, right: true },
    { header: 'UPDATED', value: (b) => b.updatedAt },
  ]);
}

/** List the boards of a project. */
export async function boardsCommand(io: CliIo, options: BoardsOptions = {}): Promise<number> {
  const root = resolveRoot(io, options.root);
  const { store } = await openSession(io, root);
  const boards = await store.listBoards();
  if (options.json) {
    println(io.stdout, JSON.stringify(boards, null, 2));
  } else if (boards.length === 0) {
    println(io.stdout, 'No boards yet. Create one with: openboard new <name>');
  } else {
    printBoards(io, boards);
  }
  return 0;
}

export interface NewBoardOptions {
  root?: string;
  /** Board id; derived from the name when omitted. */
  id?: string;
  description?: string;
  /** Start it from this template. */
  template?: string;
  json?: boolean;
}

/** Create a board. Prints its id. */
export async function newBoardCommand(
  io: CliIo,
  name: string,
  options: NewBoardOptions = {},
): Promise<number> {
  const root = resolveRoot(io, options.root);
  const { store } = await openSession(io, root);
  const summary = await store.createBoard({
    name,
    ...(options.id !== undefined ? { id: options.id } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.template !== undefined ? { template: options.template } : {}),
  });
  if (options.json) println(io.stdout, JSON.stringify(summary, null, 2));
  else {
    println(
      io.stdout,
      `Created board ${summary.id}${options.template ? ` from the template ${options.template}` : ''}`,
    );
  }
  return 0;
}
