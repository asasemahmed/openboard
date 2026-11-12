/**
 * The plugins of one server (see `OpenBoardPlugin` in core): checked once at
 * startup, then the source of this server's extra types, templates, exporters
 * and importers, and of its batch hooks. Everything lives on the instance, so
 * two servers in one process never see each other's plugins.
 */
import {
  type Actor,
  type Batch,
  type Board,
  type BoardApi,
  BUILTIN_TEMPLATES,
  EdgeTypesSchema,
  EXPORTERS,
  type Exporter,
  findExporter as findBuiltinExporter,
  findImporter as findBuiltinImporter,
  IMPORTERS,
  type Importer,
  mergeTypes,
  NodeTypesSchema,
  OpenBoardError,
  type OpenBoardPlugin,
  type PluginInfo,
  type PluginTeardown,
  type ProjectConfig,
  type TemplateDef,
  TemplateIdSchema,
  type TypeConflict,
  type TypeRegistry,
} from '@openboard/core';
import type { z } from 'zod';
import { errorMessage } from './fsutil.js';

const PLUGIN_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,99}$/;
const FORMAT_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const EXTENSION = /^\.[A-Za-z0-9][A-Za-z0-9.]{0,19}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** Batches waiting for one plugin's `onBatch`; beyond this, new ones are dropped and logged. */
export const PLUGIN_QUEUE_LIMIT = 1000;
/** How long closing waits for running `onBatch` calls before tearing down. */
const DRAIN_MS = 2000;

interface Checked {
  plugin: OpenBoardPlugin;
  nodeTypes: z.infer<typeof NodeTypesSchema>;
  edgeTypes: z.infer<typeof EdgeTypesSchema>;
}

function refuse(message: string): never {
  throw new OpenBoardError('invalid_request', `plugins: ${message}`);
}

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join('.') || 'value'}: ${i.message}`)
    .join('; ');
}

function ordinal(n: number): string {
  const suffix =
    n % 10 === 1 && n !== 11
      ? 'st'
      : n % 10 === 2 && n !== 12
        ? 'nd'
        : n % 10 === 3 && n !== 13
          ? 'rd'
          : 'th';
  return `${n}${suffix}`;
}

const label = (plugin: OpenBoardPlugin) =>
  `plugin "${plugin.name}"${plugin.version ? ` ${plugin.version}` : ''}`;

/**
 * Check every plugin and every clash between them, before anything starts.
 * Throws `invalid_request` naming the plugins involved.
 */
function check(plugins: readonly unknown[]): Checked[] {
  const out: Checked[] = [];
  const names = new Map<string, OpenBoardPlugin>();
  const nodeTypes = new Map<string, OpenBoardPlugin>();
  const edgeTypes = new Map<string, OpenBoardPlugin>();
  const templates = new Map<string, OpenBoardPlugin>();
  const exporters = new Map<string, OpenBoardPlugin>();
  const importers = new Map<string, OpenBoardPlugin>();
  const claim = (
    seen: Map<string, OpenBoardPlugin>,
    key: string,
    plugin: OpenBoardPlugin,
    what: string,
  ) => {
    const other = seen.get(key);
    if (other) refuse(`${label(plugin)} and ${label(other)} both provide ${what}`);
    seen.set(key, plugin);
  };

  plugins.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) refuse(`plugin ${index + 1} is not an object`);
    const plugin = raw as OpenBoardPlugin;
    if (typeof plugin.name !== 'string' || !PLUGIN_NAME.test(plugin.name)) {
      refuse(
        `plugin ${index + 1} needs a name of lowercase letters, digits and . _ - (npm style), got ${JSON.stringify(plugin.name)}`,
      );
    }
    const other = names.get(plugin.name);
    if (other) {
      refuse(
        `two plugins are named "${plugin.name}" (${label(other)} and ${label(plugin)}, the ${ordinal(plugins.indexOf(other) + 1)} and ${ordinal(index + 1)} given); plugin names must be unique`,
      );
    }
    names.set(plugin.name, plugin);
    if (
      plugin.version !== undefined &&
      (typeof plugin.version !== 'string' || plugin.version.length > 40)
    ) {
      refuse(`${label(plugin)}: version must be a string of at most 40 characters`);
    }
    for (const hook of ['onBatch', 'setup'] as const) {
      if (plugin[hook] !== undefined && typeof plugin[hook] !== 'function') {
        refuse(`${label(plugin)}: ${hook} must be a function`);
      }
    }

    const nodes = NodeTypesSchema.safeParse(plugin.nodeTypes ?? {});
    if (!nodes.success) refuse(`${label(plugin)}: invalid nodeTypes: ${issues(nodes.error)}`);
    const edges = EdgeTypesSchema.safeParse(plugin.edgeTypes ?? {});
    if (!edges.success) refuse(`${label(plugin)}: invalid edgeTypes: ${issues(edges.error)}`);
    for (const type of Object.keys(nodes.data)) claim(nodeTypes, type, plugin, `node type ${type}`);
    for (const type of Object.keys(edges.data)) claim(edgeTypes, type, plugin, `edge type ${type}`);

    for (const template of plugin.templates ?? []) {
      const id = (template as Partial<TemplateDef>)?.id;
      if (!TemplateIdSchema.safeParse(id).success) {
        refuse(
          `${label(plugin)}: template id ${JSON.stringify(id)} is not lowercase letters, digits and dashes`,
        );
      }
      if (
        typeof template.name !== 'string' ||
        template.name.length === 0 ||
        template.name.length > 80 ||
        typeof template.description !== 'string' ||
        template.description.length > 1000 ||
        !Array.isArray(template.tags) ||
        template.tags.length > 10 ||
        template.tags.some((tag) => typeof tag !== 'string' || tag.length > 40) ||
        typeof template.build !== 'function'
      ) {
        refuse(
          `${label(plugin)}: template "${id}" needs a name (at most 80 characters), a description, up to 10 tags and a build function`,
        );
      }
      if (BUILTIN_TEMPLATES.some((t) => t.id === id)) {
        refuse(`${label(plugin)}: template "${id}" is the id of a built-in template`);
      }
      claim(templates, id as string, plugin, `template "${id}"`);
    }

    for (const exporter of plugin.exporters ?? []) {
      const name = (exporter as Partial<Exporter>)?.name;
      if (typeof name !== 'string' || !FORMAT_NAME.test(name)) {
        refuse(
          `${label(plugin)}: exporter name ${JSON.stringify(name)} is not lowercase letters, digits and dashes`,
        );
      }
      if (findBuiltinExporter(name)) refuse(`${label(plugin)}: exporter "${name}" is built in`);
      if (
        typeof exporter.extension !== 'string' ||
        !EXTENSION.test(exporter.extension) ||
        typeof exporter.mime !== 'string' ||
        !MIME.test(exporter.mime) ||
        typeof exporter.description !== 'string' ||
        typeof exporter.render !== 'function'
      ) {
        refuse(
          `${label(plugin)}: exporter "${name}" needs an extension such as ".csv", a mime type such as "text/csv", a description and a render function`,
        );
      }
      claim(exporters, name, plugin, `exporter "${name}"`);
    }

    for (const importer of plugin.importers ?? []) {
      const name = (importer as Partial<Importer>)?.name;
      if (typeof name !== 'string' || !FORMAT_NAME.test(name)) {
        refuse(
          `${label(plugin)}: importer name ${JSON.stringify(name)} is not lowercase letters, digits and dashes`,
        );
      }
      if (findBuiltinImporter(name)) refuse(`${label(plugin)}: importer "${name}" is built in`);
      if (
        !Array.isArray(importer.extensions) ||
        importer.extensions.some((e) => typeof e !== 'string' || !EXTENSION.test(e)) ||
        typeof importer.description !== 'string' ||
        typeof importer.parse !== 'function'
      ) {
        refuse(
          `${label(plugin)}: importer "${name}" needs extensions such as [".csv"], a description and a parse function`,
        );
      }
      claim(importers, name, plugin, `importer "${name}"`);
    }
    out.push({ plugin, nodeTypes: nodes.data, edgeTypes: edges.data });
  });
  return out;
}

export interface PluginTemplate {
  def: TemplateDef;
  plugin: string;
}

export interface PluginSetupContext {
  root: string;
  log: (line: string) => void;
  api: (actor: Actor) => BoardApi;
}

export class PluginHost {
  private readonly checked: Checked[];
  private readonly queues = new Map<string, { chain: Promise<void>; pending: number }>();
  private teardowns: Array<{ name: string; run: PluginTeardown }> = [];
  private closed = false;
  private memo: { config: ProjectConfig; types: TypeRegistry; conflicts: TypeConflict[] } | null =
    null;

  /** Throws `invalid_request` for an invalid plugin or a clash between two of them. */
  constructor(
    plugins: readonly OpenBoardPlugin[] = [],
    private readonly log: (line: string) => void = () => {},
  ) {
    if (!Array.isArray(plugins)) refuse('plugins must be an array');
    this.checked = check(plugins);
  }

  get count(): number {
    return this.checked.length;
  }

  /** The declared types in effect under `config`: the project's, then each plugin's. */
  types(config: ProjectConfig): { types: TypeRegistry; conflicts: TypeConflict[] } {
    if (this.memo?.config === config) return this.memo;
    const merged = mergeTypes(
      { nodeTypes: config.nodeTypes, edgeTypes: config.edgeTypes },
      this.checked.map((c) => ({
        name: c.plugin.name,
        nodeTypes: c.nodeTypes,
        edgeTypes: c.edgeTypes,
      })),
    );
    this.memo = { config, ...merged };
    return this.memo;
  }

  /** Every plugin with what of it is not in effect, for `GET /api/info`. */
  info(config: ProjectConfig): PluginInfo[] {
    const { conflicts } = this.types(config);
    return this.checked.map(({ plugin }) => {
      const entry: PluginInfo = {
        name: plugin.name,
        warnings: conflicts.filter((c) => c.plugin === plugin.name).map((c) => c.message),
      };
      if (plugin.version !== undefined) entry.version = plugin.version;
      return entry;
    });
  }

  /** Built-in exporters, then the plugins'. */
  exporters(): Array<Exporter & { plugin?: string }> {
    return [
      ...EXPORTERS,
      ...this.checked.flatMap(({ plugin }) =>
        (plugin.exporters ?? []).map((e) => ({ ...e, plugin: plugin.name })),
      ),
    ];
  }

  importers(): Array<Importer & { plugin?: string }> {
    return [
      ...IMPORTERS,
      ...this.checked.flatMap(({ plugin }) =>
        (plugin.importers ?? []).map((i) => ({ ...i, plugin: plugin.name })),
      ),
    ];
  }

  findExporter(name: string): (Exporter & { plugin?: string }) | undefined {
    return this.exporters().find((e) => e.name === name);
  }

  findImporter(name: string): (Importer & { plugin?: string }) | undefined {
    return this.importers().find((i) => i.name === name);
  }

  /** A plugin importer whose extension `filename` ends with. */
  importerForFile(filename: string): Importer | undefined {
    const lower = filename.toLowerCase();
    return this.importers()
      .slice(IMPORTERS.length)
      .find((i) => i.extensions.some((ext) => lower.endsWith(ext.toLowerCase())));
  }

  templates(): PluginTemplate[] {
    return this.checked.flatMap(({ plugin }) =>
      (plugin.templates ?? []).map((def) => ({ def, plugin: plugin.name })),
    );
  }

  /**
   * Run every `setup`, in order. If one fails, the teardowns of those already
   * set up run (in reverse) and the error is thrown, naming the plugin.
   */
  async setup(ctx: (plugin: OpenBoardPlugin) => PluginSetupContext): Promise<void> {
    for (const { plugin } of this.checked) {
      if (!plugin.setup) continue;
      try {
        const teardown = await plugin.setup(ctx(plugin));
        if (typeof teardown === 'function')
          this.teardowns.push({ name: plugin.name, run: teardown });
      } catch (error) {
        await this.teardown();
        throw new OpenBoardError(
          'unavailable',
          `plugin "${plugin.name}" failed to set up: ${errorMessage(error)}`,
        );
      }
    }
  }

  /**
   * Hand a batch to every `onBatch`, without waiting: each plugin gets its
   * batches one at a time and in order, and its errors are logged.
   */
  batch(boardId: string, batch: Batch, board: () => Board): void {
    if (this.closed) return;
    for (const { plugin } of this.checked) {
      const hook = plugin.onBatch;
      if (!hook) continue;
      let queue = this.queues.get(plugin.name);
      if (!queue) {
        queue = { chain: Promise.resolve(), pending: 0 };
        this.queues.set(plugin.name, queue);
      }
      if (queue.pending >= PLUGIN_QUEUE_LIMIT) {
        this.log(`plugin "${plugin.name}": onBatch is behind; batch ${batch.id} was not delivered`);
        continue;
      }
      const q = queue;
      q.pending++;
      const event = { boardId, batch: { ...batch }, board };
      q.chain = q.chain.then(async () => {
        try {
          if (!this.closed) await hook.call(plugin, event);
        } catch (error) {
          this.log(
            `plugin "${plugin.name}": onBatch failed for batch ${batch.id}: ${errorMessage(error)}`,
          );
        } finally {
          q.pending--;
        }
      });
    }
  }

  /** Stop delivering batches, give running hooks a moment, then tear down in reverse order. */
  async close(): Promise<void> {
    if (this.closed) return;
    const chains = [...this.queues.values()].map((q) => q.chain);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(chains),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DRAIN_MS);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    this.closed = true;
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    const list = this.teardowns.reverse();
    this.teardowns = [];
    for (const { name, run } of list) {
      try {
        await run();
      } catch (error) {
        this.log(`plugin "${name}": teardown failed: ${errorMessage(error)}`);
      }
    }
  }
}
