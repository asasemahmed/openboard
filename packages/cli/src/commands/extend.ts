/**
 * Types and templates from the terminal. With a server running they go
 * through it (so plugins' types and templates count); without one, the
 * built-in templates, the project's templates in `.openboard/templates/` and
 * the types declared in `.openboard/config.json` are read directly.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type ApplyResult,
  type ApplyTemplateRequest,
  applyOps,
  BUILTIN_TEMPLATES,
  checkBoardAgainstTypes,
  countAdded,
  mergeTypes,
  parseConfig,
  renderSchema,
  renderTemplates,
  serializeBoard,
  TemplateIdSchema,
  type TemplateSummary,
  type TypeRegistry,
} from '@openboard/core';
import { CliError, isNodeError } from '../lib/errors.js';
import { type CliIo, println } from '../lib/io.js';
import { cliActor, resolveRoot } from '../lib/project.js';
import { projectPaths } from '../lib/server.js';
import { FileStore, openSession, type Session } from '../lib/store.js';
import { projectTemplates, templateOps } from '../lib/templates.js';
import { defaultBoardId } from './export.js';

const BOARD_SUFFIX = '.board.json';

/** Templates text for the terminal: core names API methods, here they are commands. */
function forTerminal(text: string): string {
  return text.replace(
    /Apply one with applyTemplate \(template: <id>, optionally frame: <frame id>\); it lands as one batch, like apply\./,
    'Apply one with: openboard template apply <id> [board] [--frame <id>] [--title <text>], or start a board with: openboard new <name> --template <id>.',
  );
}

export interface TemplatesOptions {
  root?: string;
  json?: boolean;
}

export async function templatesCommand(io: CliIo, options: TemplatesOptions = {}): Promise<number> {
  const root = resolveRoot(io, options.root);
  const session = await openSession(io, root);
  let list: { templates: TemplateSummary[]; text: string };
  if (session.client) list = await session.client.templates();
  else {
    const project = await projectTemplates(root);
    const summaries: TemplateSummary[] = BUILTIN_TEMPLATES.filter((t) => !project.has(t.id)).map(
      (t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        tags: t.tags,
        source: 'builtin',
        ...countAdded(t.build()),
      }),
    );
    for (const [id, board] of project) {
      summaries.push({
        id,
        name: board.name,
        description: board.description ?? '',
        tags: [],
        source: 'project',
        nodeCount: Object.keys(board.nodes).length,
        edgeCount: Object.keys(board.edges).length,
      });
    }
    list = renderTemplates(summaries, { maxTokens: 50_000 });
  }
  if (options.json) println(io.stdout, JSON.stringify(list.templates, null, 2));
  else println(io.stdout, forTerminal(list.text));
  return 0;
}

export interface TemplateApplyOptions {
  root?: string;
  frame?: string;
  title?: string;
  dryRun?: boolean;
}

function describe(result: ApplyResult): string {
  const applied = result.applied;
  const n = applied?.addedNodes.length ?? 0;
  const e = applied?.addedEdges.length ?? 0;
  return `${n} node${n === 1 ? '' : 's'}, ${e} edge${e === 1 ? '' : 's'}`;
}

/** Apply a template to a board; with the server, as you, through the normal apply path. */
export async function templateApplyCommand(
  io: CliIo,
  template: string,
  boardArg: string | undefined,
  options: TemplateApplyOptions = {},
): Promise<number> {
  const root = resolveRoot(io, options.root);
  const session = await openSession(io, root);
  const board = boardArg ?? (await defaultBoardId(session.store));
  const request: ApplyTemplateRequest = { template };
  if (options.frame !== undefined) request.frame = options.frame;
  if (options.title !== undefined) request.title = options.title;
  if (options.dryRun) request.dryRun = true;

  if (session.client) {
    const result = await session.client.applyTemplate(board, request);
    if (result.status === 'invalid') {
      throw new CliError(
        `the template was refused; nothing was changed:\n${(result.errors ?? []).map((e) => `  ops[${e.index}]: ${e.message}`).join('\n')}`,
      );
    }
    for (const warning of result.warnings ?? []) println(io.stderr, `warning: ${warning}`);
    println(
      io.stdout,
      options.dryRun
        ? `Dry run: template ${template} on ${board} would add ${describe(result)}. Nothing was changed.`
        : `Applied template ${template} to ${board}: added ${describe(result)}.`,
    );
    return 0;
  }

  let ops = await templateOps(root, template, options.title);
  if (options.frame !== undefined) {
    const frame = options.frame;
    ops = ops.map((op) =>
      op.op === 'add_node' && op.node.parent === undefined
        ? { ...op, node: { ...op.node, parent: frame } }
        : op,
    );
  }
  const store = new FileStore(root);
  const outcome = applyOps(await store.getBoard(board), ops, { actor: cliActor(io.env) });
  if (!outcome.ok) {
    throw new CliError(
      `the template was refused; nothing was changed:\n${outcome.errors.map((e) => `  ops[${e.index}]: ${e.message}`).join('\n')}`,
    );
  }
  const what = describe({ status: 'applied', cursor: 0, refs: {}, applied: outcome.applied });
  if (options.dryRun) {
    println(
      io.stdout,
      `Dry run: template ${template} on ${board} would add ${what}. Nothing was changed.`,
    );
    return 0;
  }
  await writeAtomic(store.paths.boardFile(board), serializeBoard(outcome.board));
  println(io.stdout, `Applied template ${template} to ${board}: added ${what}.`);
  println(
    io.stdout,
    'The new nodes have no position yet; the next automatic layout places them (the next change made through the server, or Tidy up on the canvas).',
  );
  return 0;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await writeFile(temp, text);
  await rename(temp, file);
}

export interface TemplateSaveOptions {
  root?: string;
  /** Replace a project template of that name. */
  force?: boolean;
}

/** Save a board as the project template `.openboard/templates/<name>.board.json`. */
export async function templateSaveCommand(
  io: CliIo,
  name: string,
  boardArg: string | undefined,
  options: TemplateSaveOptions = {},
): Promise<number> {
  if (!TemplateIdSchema.safeParse(name).success) {
    throw new CliError(
      `"${name}" cannot be a template name: use lowercase letters, digits and dashes, starting with a letter`,
    );
  }
  const root = resolveRoot(io, options.root);
  const session = await openSession(io, root);
  const board = await session.store.getBoard(boardArg ?? (await defaultBoardId(session.store)));
  const dir = path.join(projectPaths(root).dir, 'templates');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}${BOARD_SUFFIX}`);
  const { comments: _comments, ...rest } = board;
  const text = serializeBoard({ ...rest, id: name });
  try {
    await writeFile(file, text, { flag: options.force ? 'w' : 'wx' });
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new CliError(
        `a project template "${name}" exists already (${file}); pass --force to replace it`,
      );
    }
    throw error;
  }
  const rel = path.relative(io.cwd, file) || file;
  println(io.stdout, `Saved board ${board.id} as the template ${name}: ${rel}`);
  println(io.stdout, 'Commit it so everyone gets it. Comments are not part of it.');
  if (BUILTIN_TEMPLATES.some((t) => t.id === name)) {
    println(io.stdout, `It replaces the built-in template ${name} in this project.`);
  }
  return 0;
}

// ── Types ────────────────────────────────────────────────────────────────────

async function projectTypes(root: string): Promise<TypeRegistry> {
  let text: string;
  try {
    text = await readFile(projectPaths(root).config, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return mergeTypes(undefined).types;
    throw error;
  }
  try {
    return mergeTypes(parseConfig(text)).types;
  } catch (error) {
    throw new CliError(
      `.openboard/config.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface TypesOptions {
  root?: string;
  json?: boolean;
}

/** The node and edge types: built-in and declared (by the project, and plugins when a server runs). */
export async function typesCommand(io: CliIo, options: TypesOptions = {}): Promise<number> {
  const root = resolveRoot(io, options.root);
  const session = await openSession(io, root);
  const result = session.client
    ? await session.client.schema({ maxTokens: 50_000 })
    : renderSchema(await projectTypes(root), { maxTokens: 50_000 });
  if (options.json) {
    const { text: _t, tokens: _k, truncated: _r, ...data } = result;
    println(io.stdout, JSON.stringify(data, null, 2));
  } else println(io.stdout, result.text);
  return 0;
}

/** Nodes that do not fit their declared type. Exits 1 when there are any. */
export async function typesCheckCommand(
  io: CliIo,
  boardArg: string | undefined,
  options: TypesOptions = {},
): Promise<number> {
  const root = resolveRoot(io, options.root);
  const session: Session = await openSession(io, root);
  const board = boardArg ?? (await defaultBoardId(session.store));
  const warnings = session.client
    ? ((await session.client.schema({ board, maxTokens: 100 })).warnings ?? [])
    : checkBoardAgainstTypes(await session.store.getBoard(board), await projectTypes(root));
  if (options.json) {
    println(io.stdout, JSON.stringify(warnings, null, 2));
    return warnings.length ? 1 : 0;
  }
  if (warnings.length === 0) {
    println(io.stdout, `Board ${board}: every node fits its declared type.`);
    return 0;
  }
  println(
    io.stdout,
    `Board ${board}: ${warnings.length} node${warnings.length === 1 ? ' does' : 's do'} not fit their declared type:`,
  );
  for (const w of warnings) println(io.stdout, `  ${w.nodeId} (${w.type}): ${w.message}`);
  println(
    io.stdout,
    'They were made before a type changed, or edited in a browser; edits through the API are checked.',
  );
  return 1;
}
