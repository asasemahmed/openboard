import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Actor } from '@openboard/core';
import { CliError } from './errors.js';
import type { CliIo } from './io.js';
import { findProjectRoot } from './server.js';

/** `--root` resolved against the working directory, or the discovered project root. */
export function resolveRoot(io: CliIo, root: string | undefined): string {
  if (root !== undefined && root !== '') {
    const resolved = path.resolve(io.cwd, root);
    if (!existsSync(resolved)) throw new CliError(`--root ${root}: no such directory`);
    return resolved;
  }
  return findProjectRoot(io.cwd);
}

/** The actor everything done from the command line is attributed to. */
export function cliActor(env: CliIo['env'] = {}): Actor {
  let name: string | undefined;
  try {
    name = os.userInfo().username;
  } catch {
    name = env.USER ?? env.USERNAME;
  }
  name = name?.trim().slice(0, 80);
  return { id: 'cli', kind: 'human', name: name || 'CLI' };
}

/** A board name for a project directory: its base name. */
export function projectName(root: string): string {
  return path.basename(path.resolve(root)).slice(0, 120) || 'OpenBoard';
}

let cachedVersion: string | undefined;

/** The `openboard` package version. */
export function cliVersion(): string {
  if (cachedVersion === undefined) {
    // Same relative location from `src/lib` (tests) and `dist/lib` (built).
    const file = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: string };
    cachedVersion = pkg.version ?? '0.0.0';
  }
  return cachedVersion;
}

export interface AppLocation {
  /** The app's `dist` directory, or undefined when the package is not installed. */
  dir: string | undefined;
  /** True when `dir/index.html` exists. */
  built: boolean;
}

/** Where the built web app lives, from the `@openboard/app` package. */
export function locateApp(): AppLocation {
  let dir: string;
  try {
    const require = createRequire(import.meta.url);
    dir = path.join(path.dirname(require.resolve('@openboard/app/package.json')), 'dist');
  } catch {
    return { dir: undefined, built: false };
  }
  return { dir, built: existsSync(path.join(dir, 'index.html')) };
}
