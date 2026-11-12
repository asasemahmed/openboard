/**
 * Live work from the terminal: the agent sessions a running server knows
 * about, and the board as it was at an earlier cursor.
 */
import { CliError } from '../lib/errors.js';
import { type CliIo, println } from '../lib/io.js';
import { resolveRoot } from '../lib/project.js';
import { openSession } from '../lib/store.js';
import { chooseExporter, writeExport } from './export.js';
import { live } from './review.js';

export interface ActivityOptions {
  root?: string;
  json?: boolean;
  /** Also list sessions that have ended. */
  all?: boolean;
}

/** The agent sessions the running server knows about, as a tree. */
export async function activityCommand(io: CliIo, options: ActivityOptions = {}): Promise<number> {
  const dir = resolveRoot(io, options.root);
  const { client } = await openSession(io, dir);
  if (!client) {
    throw new CliError(
      `Activity needs the running server, and none is running for ${dir}; start it with \`openboard start\``,
    );
  }
  const result = await client.sessions({
    maxTokens: 50_000,
    ...(options.all ? { includeEnded: true } : {}),
  });
  if (options.json) println(io.stdout, JSON.stringify(result.sessions, null, 2));
  else println(io.stdout, result.text);
  return 0;
}

export interface SnapshotOptions {
  root?: string;
  format?: string;
  out?: string;
}

function parseCursor(value: string): number {
  const cursor = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(cursor)) {
    throw new CliError(
      `cursor ${JSON.stringify(value)}: give a whole number, as history and changes show it`,
    );
  }
  return cursor;
}

/** Write a board as it was right after `cursor`, in one of the export formats. */
export async function snapshotCommand(
  io: CliIo,
  cursorArg: string,
  board: string | undefined,
  options: SnapshotOptions = {},
): Promise<number> {
  const cursor = parseCursor(cursorArg);
  const exporter = chooseExporter(options);
  const { client, board: id } = await live(io, options.root, board, 'A snapshot');
  const snapshot = await client.snapshotAt(id, cursor);
  await writeExport(io, exporter.render(snapshot), options.out);
  return 0;
}
