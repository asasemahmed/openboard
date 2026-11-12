/** Templates without a server: the built-in ones and the project's, as operations. */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Board,
  findBuiltinTemplate,
  type Op,
  opsFromBoard,
  parseBoard,
  TemplateIdSchema,
} from '@openboard/core';
import { CliError, isNodeError } from './errors.js';
import { projectPaths } from './server.js';

const BOARD_SUFFIX = '.board.json';

/** Project templates on disk: id (file name) to the board in it. */
export async function projectTemplates(root: string): Promise<Map<string, Board>> {
  const dir = path.join(projectPaths(root).dir, 'templates');
  const out = new Map<string, Board>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return out;
    throw error;
  }
  for (const name of names.filter((n) => n.endsWith(BOARD_SUFFIX)).sort()) {
    const id = name.slice(0, -BOARD_SUFFIX.length);
    if (!TemplateIdSchema.safeParse(id).success) continue;
    try {
      out.set(id, parseBoard(await readFile(path.join(dir, name), 'utf8')));
    } catch {
      // A broken template file is skipped here; the server reports it.
    }
  }
  return out;
}

/** The operations of a template, without a server: built-in or project templates. */
export async function templateOps(
  root: string,
  id: string,
  title: string | undefined,
): Promise<Op[]> {
  const project = (await projectTemplates(root)).get(id);
  if (project) return opsFromBoard(project);
  const builtin = findBuiltinTemplate(id);
  if (!builtin) {
    throw new CliError(
      `no template "${id}" (see openboard templates; plugin templates need the running server)`,
    );
  }
  return builtin.build(title !== undefined ? { title } : {});
}
