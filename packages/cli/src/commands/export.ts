import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EXPORTERS,
  type Exporter,
  exporterForFile,
  FORMAT_NAMES,
  findExporter,
} from '../exporters.js';
import { CliError } from '../lib/errors.js';
import { type CliIo, println } from '../lib/io.js';
import { resolveRoot } from '../lib/project.js';
import { type BoardStore, openSession } from '../lib/store.js';

export interface ExportOptions {
  root?: string;
  /** One of the names in `EXPORTERS`. Defaults to the `--out` extension, then `json`. */
  format?: string;
  /** Write here instead of stdout. */
  out?: string;
  /** For `svg`. */
  theme?: 'light' | 'dark';
}

/** The exporter for `--format`, else the one `--out`'s extension selects, else `json`. */
export function chooseExporter(options: Pick<ExportOptions, 'format' | 'out'>): Exporter {
  if (options.format !== undefined) {
    const exporter = findExporter(options.format);
    if (!exporter) {
      throw new CliError(
        `unknown format "${options.format}" (choose one of: ${FORMAT_NAMES.join(', ')})`,
      );
    }
    return exporter;
  }
  return (options.out !== undefined && exporterForFile(options.out)) || (EXPORTERS[0] as Exporter);
}

/** The board to use when none is named: the only one, else `main`. */
export async function defaultBoardId(store: BoardStore): Promise<string> {
  const boards = await store.listBoards();
  if (boards.length === 1 && boards[0]) return boards[0].id;
  if (boards.some((board) => board.id === 'main')) return 'main';
  if (boards.length === 0) throw new CliError('no boards yet (create one with: openboard init)');
  throw new CliError(
    `several boards and none is "main"; name one: ${boards.map((b) => b.id).join(', ')}`,
  );
}

/** Write a board in one of the export formats. */
export async function exportCommand(
  io: CliIo,
  boardId: string | undefined,
  options: ExportOptions = {},
): Promise<number> {
  const exporter = chooseExporter(options);
  const root = resolveRoot(io, options.root);
  const { store } = await openSession(io, root);
  const board = await store.getBoard(boardId ?? (await defaultBoardId(store)));
  await writeExport(
    io,
    exporter.render(board, options.theme ? { theme: options.theme } : {}),
    options.out,
  );
  return 0;
}

/** Write exported text to stdout, or to `out` (relative to the working directory) with a note on stderr. */
export async function writeExport(
  io: CliIo,
  rendered: string,
  out: string | undefined,
): Promise<void> {
  const text = rendered.endsWith('\n') ? rendered : `${rendered}\n`;
  if (out === undefined || out === '-') {
    io.stdout.write(text);
  } else {
    const file = path.resolve(io.cwd, out);
    await writeFile(file, text);
    println(io.stderr, `Wrote ${path.relative(io.cwd, file) || file}`);
  }
}
