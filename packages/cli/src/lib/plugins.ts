/**
 * Loading server plugins named on the command line. Loading a plugin runs its
 * code with the server's privileges, so it only ever happens for modules the
 * person starting the server names with `--plugin`: never from a config file
 * or the project directory on its own.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OpenBoardPlugin } from '@openboard/core';
import { CliError } from './errors.js';

/** Whether `spec` names a file rather than a package. */
function isPath(spec: string): boolean {
  return (
    spec.startsWith('.') ||
    spec.startsWith('/') ||
    path.isAbsolute(spec) ||
    spec.endsWith('.js') ||
    spec.endsWith('.mjs')
  );
}

/** The module URL for a `--plugin` value: a file path from `cwd`, or a package installed for `cwd`. */
export function pluginUrl(spec: string, cwd: string): string {
  if (isPath(spec)) {
    const file = path.resolve(cwd, spec);
    if (!existsSync(file)) throw new CliError(`--plugin ${spec}: no such file (${file})`);
    return pathToFileURL(file).href;
  }
  try {
    return pathToFileURL(createRequire(path.join(cwd, 'package.json')).resolve(spec)).href;
  } catch {
    throw new CliError(
      `--plugin ${spec}: no such package installed for ${cwd}; give a path to the module instead`,
    );
  }
}

/**
 * Import each module and take its plugin: the default export, else the named
 * export `plugin`. A function is called (and awaited) to create the instance.
 */
export async function loadPlugins(
  specs: readonly string[],
  cwd: string,
): Promise<OpenBoardPlugin[]> {
  const plugins: OpenBoardPlugin[] = [];
  for (const spec of specs) {
    const url = pluginUrl(spec, cwd);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(url)) as Record<string, unknown>;
    } catch (error) {
      throw new CliError(
        `--plugin ${spec}: the module failed to load: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let candidate = mod.default ?? mod.plugin;
    if (typeof candidate === 'function') candidate = await (candidate as () => unknown)();
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof (candidate as { name?: unknown }).name !== 'string'
    ) {
      throw new CliError(
        `--plugin ${spec}: the module exports no plugin (a default export or "plugin": an object with a name, or a function returning one)`,
      );
    }
    plugins.push(candidate as OpenBoardPlugin);
  }
  return plugins;
}
