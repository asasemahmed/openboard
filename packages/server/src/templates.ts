/**
 * The templates one server offers: the built-in ones, those of its plugins,
 * and the project's own: every `.openboard/templates/<name>.board.json`. A
 * project template is read from disk each time it is listed or applied, so
 * adding or editing one needs no restart. A project template with the id of
 * a built-in or plugin template takes its place.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  BUILTIN_TEMPLATES,
  countAdded,
  type Op,
  OpenBoardError,
  opsFromBoard,
  parseBoard,
  type TemplateBuildOptions,
  type TemplateDef,
  type TemplateSummary,
} from '@openboard/core';
import { errorMessage, isErrno, readIfExists } from './fsutil.js';
import { boardIdFromFile } from './paths.js';
import type { PluginHost } from './plugins.js';

/** Project template files larger than this are not read. */
export const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;

export interface ResolvedTemplate {
  summary: TemplateSummary;
  /**
   * The batch that creates it. `emptyTarget`: the board it goes on is empty
   * and nothing asked for a frame, so a project template keeps the positions
   * of its top-level nodes too.
   */
  build(options: TemplateBuildOptions & { emptyTarget?: boolean }): Op[];
}

function buildDef(
  def: TemplateDef,
  plugin: string | undefined,
  options: TemplateBuildOptions,
): Op[] {
  let ops: unknown;
  try {
    ops = def.build(options.title !== undefined ? { title: options.title } : {});
  } catch (error) {
    const by = plugin ? ` of plugin "${plugin}"` : '';
    throw new OpenBoardError(
      'invalid_request',
      `template "${def.id}"${by} failed to build: ${errorMessage(error)}`,
    );
  }
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new OpenBoardError(
      'invalid_request',
      `template "${def.id}"${plugin ? ` of plugin "${plugin}"` : ''} built no operations`,
    );
  }
  return ops as Op[];
}

function fromDef(def: TemplateDef, plugin?: string): ResolvedTemplate {
  let counts = { nodeCount: 0, edgeCount: 0 };
  try {
    counts = countAdded(buildDef(def, plugin, {}));
  } catch {
    // Counted as empty; applying it reports the problem.
  }
  const summary: TemplateSummary = {
    id: def.id,
    name: def.name,
    description: def.description,
    tags: [...def.tags],
    source: plugin === undefined ? 'builtin' : 'plugin',
    ...counts,
  };
  if (plugin !== undefined) summary.plugin = plugin;
  return { summary, build: (options) => buildDef(def, plugin, options) };
}

export class TemplateCatalog {
  private readonly fixed: ResolvedTemplate[];

  constructor(
    private readonly dir: string,
    plugins: PluginHost,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.fixed = [
      ...BUILTIN_TEMPLATES.map((def) => fromDef(def)),
      ...plugins.templates().map(({ def, plugin }) => fromDef(def, plugin)),
    ];
  }

  /** Every template, project templates last; a project template replaces one with its id. */
  async list(): Promise<TemplateSummary[]> {
    const project = await this.project();
    const ids = new Set(project.map((t) => t.summary.id));
    return [...this.fixed.filter((t) => !ids.has(t.summary.id)), ...project].map((t) => t.summary);
  }

  /** The template with this id. Throws `not_found` naming the ones there are. */
  async get(id: string): Promise<ResolvedTemplate> {
    const fromProject = await this.projectTemplate(id);
    if (fromProject) return fromProject;
    const found = this.fixed.find((t) => t.summary.id === id);
    if (found) return found;
    const all = (await this.list()).map((t) => t.id).join(', ');
    throw new OpenBoardError('not_found', `no template "${id}"; templates: ${all}`);
  }

  private async project(): Promise<ResolvedTemplate[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return [];
      throw error;
    }
    const out: ResolvedTemplate[] = [];
    for (const name of names.sort()) {
      const id = boardIdFromFile(name);
      if (id === null) continue;
      try {
        const template = await this.projectTemplate(id);
        if (template) out.push(template);
      } catch (error) {
        this.log(`template ${name} is not listed: ${errorMessage(error)}`);
      }
    }
    return out;
  }

  /** `.openboard/templates/<id>.board.json` as a template, or undefined when there is none. */
  private async projectTemplate(id: string): Promise<ResolvedTemplate | undefined> {
    if (boardIdFromFile(`${id}.board.json`) === null) return undefined;
    const file = path.join(this.dir, `${id}.board.json`);
    try {
      if ((await stat(file)).size > MAX_TEMPLATE_BYTES) {
        throw new OpenBoardError(
          'invalid_request',
          `template file ${file} is larger than ${MAX_TEMPLATE_BYTES} bytes`,
        );
      }
    } catch (error) {
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return undefined;
      throw error;
    }
    const bytes = await readIfExists(file);
    if (bytes === null) return undefined;
    let board: ReturnType<typeof parseBoard>;
    try {
      board = parseBoard(bytes.toString('utf8'));
    } catch (error) {
      throw new OpenBoardError(
        'invalid_request',
        `template file templates/${id}.board.json does not parse: ${errorMessage(error)}`,
      );
    }
    const summary: TemplateSummary = {
      id,
      name: board.name,
      description: board.description ?? '',
      tags: [],
      source: 'project',
      nodeCount: Object.keys(board.nodes).length,
      edgeCount: Object.keys(board.edges).length,
    };
    return {
      summary,
      build: (options) => {
        const ops = opsFromBoard(board, { keepTopLevelViews: options.emptyTarget === true });
        if (ops.length === 0) {
          throw new OpenBoardError('invalid_request', `template "${id}" has no nodes`);
        }
        return ops;
      },
    };
  }
}
