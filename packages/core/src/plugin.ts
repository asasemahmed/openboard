/**
 * The plugin interface: how third parties extend a server without forking it.
 *
 * A plugin can declare node and edge types, add templates, exporters and
 * importers, react to applied batches, and run code for the server's
 * lifetime. Loading code is a trust decision, so a server never discovers
 * plugins on its own: they are passed to it explicitly
 * (`ServerOptions.plugins`). Plugin authors depend on `@openboard/core` alone.
 */
import type { BoardApi } from './api.js';
import type { Batch } from './collab.js';
import type { Exporter, Importer } from './interop/types.js';
import type { Actor, Board } from './schema.js';
import type { TemplateDef } from './templates/types.js';
import type { EdgeTypeDef, NodeTypeDef } from './typedefs.js';

/** What `onBatch` receives after a batch was applied. */
export interface PluginBatchEvent {
  boardId: string;
  /** The history batch (see `BoardApi.history`): who, when, why, and the ids it touched. */
  batch: Batch;
  /** The board as it is now. Built on demand, so call it only when needed. */
  board: () => Board;
}

/** What `setup` receives. */
export interface PluginContext {
  /** The project root the server serves. */
  root: string;
  /** Write a line to the server's log, prefixed with the plugin's name. */
  log(line: string): void;
  /**
   * An in-process session bound to `actor`, with owner access. Use a
   * `system` actor for upkeep the review policy should not hold up, or an
   * `agent` actor to be treated like any other agent.
   */
  api(actor: Actor): BoardApi;
}

export type PluginTeardown = () => void | Promise<void>;

export interface OpenBoardPlugin {
  /** Unique among the server's plugins: lowercase, npm-like (`estimates`, `@acme/risk`). */
  name: string;
  version?: string;
  /** Declared node types by `x:` name. The project's config wins on a clash. */
  nodeTypes?: Record<string, NodeTypeDef>;
  edgeTypes?: Record<string, EdgeTypeDef>;
  templates?: TemplateDef[];
  /** Served by `exportBoard` and `GET /api/boards/:id/export?format=<name>`. */
  exporters?: Exporter[];
  /** Used by `importInto` with `format: <name>`, or detected from a file extension. */
  importers?: Importer[];
  /**
   * Called after each applied batch that changed nodes or edges, including the
   * plugin's own (check `batch.actor`). Calls are made one at a time per
   * plugin, in order; errors are logged and never affect the batch, and a
   * slow handler never holds up an apply.
   */
  onBatch?(event: PluginBatchEvent): void | Promise<void>;
  /**
   * Called once when the server starts, in the order plugins were given. May
   * return a teardown, called when the server closes (in reverse order). An
   * error here stops the server from starting.
   */
  setup?(ctx: PluginContext): void | PluginTeardown | Promise<void | PluginTeardown>;
}

/** An identity function that gives a plugin object its type. */
export function definePlugin<T extends OpenBoardPlugin>(plugin: T): T {
  return plugin;
}

/** What `GET /api/info` says about each plugin. */
export interface PluginInfo {
  name: string;
  version?: string;
  /** Declarations that are not in effect, such as types the project also declares. */
  warnings: string[];
}
