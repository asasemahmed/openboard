import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EXPORTERS, type Exporter, exporterForFile, findExporter } from '../exporters.js';
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
}

function chooseExporter(options: ExportOptions): Exporter {
  if (options.format !== undefined) {
    const exporter = findExporter(options.format);
    if (!exporter) {
      const names = EXPORTERS.map((e) => e.name).join(', ');
      throw new CliError(`unknown format "${options.format}" (choose one of: ${names})`);
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
  let text = exporter.render(board);
  if (!text.endsWith('\n')) text += '\n';

  if (options.out === undefined || options.out === '-') {
    io.stdout.write(text);
  } else {
    const file = path.resolve(io.cwd, options.out);
    await writeFile(file, text);
    println(io.stderr, `Wrote ${path.relative(io.cwd, file) || file}`);
  }
  return 0;
}
