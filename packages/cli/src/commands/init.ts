import path from 'node:path';
import { emptyBoard } from '@openboard/core';
import { type CliIo, println } from '../lib/io.js';
import { projectName } from '../lib/project.js';
import { projectPaths } from '../lib/server.js';
import { ensureProjectDir, readBoardFiles, writeNewBoardFile } from '../lib/store.js';

export interface InitOptions {
  /** Directory to initialize. Defaults to the working directory, not the discovered root. */
  root?: string;
}

/** Create `.openboard/` with an empty `main` board. Safe to run again; never overwrites a board. */
export async function initCommand(io: CliIo, options: InitOptions = {}): Promise<number> {
  const root = path.resolve(io.cwd, options.root ?? '.');
  const paths = projectPaths(root);
  const created = await ensureProjectDir(paths);

  const existing = await readBoardFiles(paths);
  if (existing.length === 0) {
    const board = emptyBoard({ id: 'main', name: projectName(root) });
    created.push(await writeNewBoardFile(paths, board));
  }

  const show = (p: string) => path.relative(io.cwd, p) || '.';
  if (created.length === 0) {
    println(io.stdout, `Already initialized: ${show(paths.dir)}`);
  } else {
    for (const file of created) println(io.stdout, `Created ${show(file)}`);
  }
  return 0;
}
