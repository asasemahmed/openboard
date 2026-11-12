/**
 * `openboard import`: add a Mermaid flowchart or a JSON Canvas to a board.
 * Core's importers turn the file into one batch of operations, so the import
 * goes through the same validated apply path as any other change.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type AppliedOps,
  applyOps,
  detectFormat,
  findImporter,
  type Importer,
  type Op,
  type OpError,
  serializeBoard,
} from '@openboard/core';
import { CliError } from '../lib/errors.js';
import { type CliIo, println } from '../lib/io.js';
import { cliActor, resolveRoot } from '../lib/project.js';
import { FileStore, openSession } from '../lib/store.js';
import { defaultBoardId } from './export.js';

export interface ImportOptions {
  root?: string;
  /** `mermaid` or `canvas`; default: recognized from the file. */
  format?: string;
  /** Put what has no frame of its own into this frame. */
  frame?: string;
  dryRun?: boolean;
  /** Create a board with this name and import into it. */
  new?: string;
  /** Read standard input instead of a file (`-`). Defaults to `process.stdin`. */
  stdin?: AsyncIterable<Buffer | string>;
}

const FORMAT_ALIASES: Record<string, string> = {
  mermaid: 'mermaid',
  mmd: 'mermaid',
  canvas: 'jsoncanvas',
  jsoncanvas: 'jsoncanvas',
};

const LABEL: Record<string, string> = { mermaid: 'Mermaid', jsoncanvas: 'JSON Canvas' };

async function readInput(io: CliIo, file: string, stdin?: AsyncIterable<Buffer | string>) {
  if (file === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin ?? process.stdin) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(path.resolve(io.cwd, file), 'utf8');
}

function chooseImporter(file: string, text: string, format: string | undefined): Importer {
  if (format !== undefined) {
    const name = FORMAT_ALIASES[format];
    const importer = name && findImporter(name);
    if (!importer)
      throw new CliError(`unknown import format "${format}" (choose mermaid or canvas)`);
    return importer;
  }
  const detected = detectFormat(file === '-' ? '' : file, text);
  const importer = detected && findImporter(detected);
  if (importer) return importer;
  if (detected === 'json') {
    throw new CliError(
      `${file} is a board file; copy it into .openboard/ instead, or import a Mermaid flowchart or a JSON Canvas`,
    );
  }
  throw new CliError(`cannot tell the format of ${file}; pass --format mermaid or --format canvas`);
}

/** Put every imported node that has no parent into `frame`. */
export function intoFrame(ops: readonly Op[], frame: string): Op[] {
  return ops.map((op) => {
    if (op.op !== 'add_node' || op.node.parent !== undefined) return op;
    return { ...op, node: { ...op.node, parent: frame } };
  });
}

function counts(applied: AppliedOps): string {
  const parts: string[] = [];
  const add = (n: number, word: string) => {
    if (n > 0) parts.push(`${n} ${word}${n === 1 ? '' : 's'}`);
  };
  add(applied.addedNodes.length, 'node');
  add(applied.addedEdges.length, 'edge');
  return parts.join(', ') || 'nothing';
}

function refused(errors: readonly OpError[]): CliError {
  const lines = errors.slice(0, 10).map((e) => `  ops[${e.index}]: ${e.message}`);
  if (errors.length > 10) lines.push(`  and ${errors.length - 10} more`);
  return new CliError(`the import was refused; nothing was changed:\n${lines.join('\n')}`);
}

/** Import a Mermaid flowchart or a JSON Canvas into a board. */
export async function importCommand(
  io: CliIo,
  file: string,
  boardArg: string | undefined,
  options: ImportOptions = {},
): Promise<number> {
  if (options.new !== undefined && boardArg !== undefined) {
    throw new CliError('pass either a board or --new <name>, not both');
  }
  const text = await readInput(io, file, options.stdin);
  const importer = chooseImporter(file, text, options.format);
  const parsed = importer.parse(text);
  for (const warning of parsed.warnings) println(io.stderr, `warning: ${warning}`);
  if (parsed.ops.length === 0) {
    println(io.stdout, `Nothing to import from ${file}.`);
    return 0;
  }
  const ops = options.frame ? intoFrame(parsed.ops, options.frame) : parsed.ops;
  const label = LABEL[importer.name] ?? importer.name;

  const root = resolveRoot(io, options.root);
  const session = await openSession(io, root);
  let board: string;
  if (options.new !== undefined) {
    if (options.dryRun) {
      println(
        io.stdout,
        `Dry run: would create board "${options.new}" and add ${ops.length} operations to it.`,
      );
      return 0;
    }
    board = (await session.store.createBoard({ name: options.new })).id;
    println(io.stdout, `Created board ${board}`);
  } else {
    board = boardArg ?? (await defaultBoardId(session.store));
  }

  if (session.client) {
    const result = await session.client.apply(board, {
      ops,
      reason: `Import from ${label}`,
      ...(options.dryRun ? { dryRun: true } : {}),
    });
    if (result.status === 'invalid') throw refused(result.errors ?? []);
    for (const warning of result.warnings ?? []) println(io.stderr, `warning: ${warning}`);
    const what = result.applied ? counts(result.applied) : `${ops.length} operations`;
    println(
      io.stdout,
      options.dryRun
        ? `Dry run: importing ${file} into ${board} would add ${what}. Nothing was changed.`
        : `Imported ${file} into ${board}: added ${what}.`,
    );
    return 0;
  }

  // No server: apply to the board file directly.
  const store = new FileStore(root);
  const current = await store.getBoard(board);
  const outcome = applyOps(current, ops, { actor: cliActor(io.env) });
  if (!outcome.ok) throw refused(outcome.errors);
  const added = counts(outcome.applied);
  if (options.dryRun) {
    println(
      io.stdout,
      `Dry run: importing ${file} into ${board} would add ${added}. Nothing was changed.`,
    );
    return 0;
  }
  const target = store.paths.boardFile(board);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  await writeFile(temp, serializeBoard(outcome.board));
  await rename(temp, target);
  println(io.stdout, `Imported ${file} into ${board}: added ${added}.`);
  const unplaced = outcome.applied.addedNodes.filter((id) => !outcome.board.nodes[id]?.view).length;
  if (unplaced > 0) {
    println(
      io.stdout,
      `${unplaced} new node${unplaced === 1 ? ' has' : 's have'} no position yet; the next automatic layout places them (the next change made through the server, or Tidy up on the canvas).`,
    );
  }
  return 0;
}
