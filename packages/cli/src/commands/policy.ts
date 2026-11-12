import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  IdSchema,
  type PolicyMode,
  PolicyModeSchema,
  type ProjectConfig,
  parseConfig,
  serializeConfig,
} from '@openboard/core';
import { CliError, isNodeError } from '../lib/errors.js';
import { type CliIo, println } from '../lib/io.js';
import { resolveRoot } from '../lib/project.js';
import { projectPaths } from '../lib/server.js';
import { ensureProjectDir, openSession } from '../lib/store.js';

/** What each mode means, in one line. */
export const POLICY_MODES: Record<PolicyMode, string> = {
  auto: 'every change applies directly',
  review_destructive:
    'adding is free, and so is changing what the agent made that nobody else touched; changing or removing anything else, or moving a pinned node, waits for review (the default)',
  review_all: 'every change waits for review',
  locked: 'the agent may read the board but not change it',
};

export interface PolicyOptions {
  root?: string;
  json?: boolean;
}

export interface PolicySetOptions {
  root?: string;
  /** Set the mode of this agent instead of the default. */
  agent?: string;
}

/** Where the settings were read from. */
type Source = 'server' | 'file' | 'defaults';

interface Settings {
  source: Source;
  file: string;
  config: ProjectConfig;
  /** Writes the new settings where they were read from. */
  save(config: ProjectConfig): Promise<ProjectConfig>;
}

async function readConfigFile(file: string): Promise<ProjectConfig | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return parseConfig(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`${file}: ${reason}`);
  }
}

/** Write `text` to `file` so that a crash leaves either the old or the new content. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await writeFile(temp, text);
  await rename(temp, file);
}

/** The settings through the running server, or from `.openboard/config.json` when none runs. */
async function settings(io: CliIo, root: string): Promise<Settings> {
  const paths = projectPaths(root);
  const { client } = await openSession(io, root);
  if (client) {
    return {
      source: 'server',
      file: paths.config,
      config: await client.getConfig(),
      save: (config) => client.setConfig(config),
    };
  }
  const stored = await readConfigFile(paths.config);
  return {
    source: stored ? 'file' : 'defaults',
    file: paths.config,
    config: stored ?? DEFAULT_CONFIG,
    save: async (config) => {
      await ensureProjectDir(paths);
      await writeAtomic(paths.config, serializeConfig(config));
      return config;
    },
  };
}

function agentId(value: string): string {
  if (!IdSchema.safeParse(value).success) {
    throw new CliError(
      `--agent ${JSON.stringify(value)} is not an actor id (letters, digits and _ . : -, at most 64 characters)`,
    );
  }
  return value;
}

function parseMode(value: string): PolicyMode {
  const parsed = PolicyModeSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError(
      `unknown mode "${value}" (choose one of: ${PolicyModeSchema.options.join(', ')})`,
    );
  }
  return parsed.data;
}

function describeSource(settings: Settings, root: string): string {
  const file = path.relative(root, settings.file) || settings.file;
  switch (settings.source) {
    case 'server':
      return `from the running server; saved in ${file}`;
    case 'file':
      return `from ${file}`;
    default:
      return `the defaults; ${file} does not exist yet`;
  }
}

/** Show the review policy: the default mode, each agent's own mode, and what the modes mean. */
export async function policyCommand(io: CliIo, options: PolicyOptions = {}): Promise<number> {
  const root = resolveRoot(io, options.root);
  const current = await settings(io, root);
  const { policy } = current.config;
  if (options.json) {
    println(
      io.stdout,
      JSON.stringify(
        { source: current.source, file: current.file, policy, modes: POLICY_MODES },
        null,
        2,
      ),
    );
    return 0;
  }
  println(io.stdout, `Review policy (${describeSource(current, root)}):`);
  const agents = Object.entries(policy.agents).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const rows: Array<[string, string]> = [
    ['default', policy.default],
    ...agents.map(([id, mode]): [string, string] => [`agent ${id}`, mode]),
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, mode] of rows) println(io.stdout, `  ${label.padEnd(width)}  ${mode}`);
  if (agents.length === 0) println(io.stdout, '  (no agent has a mode of its own)');
  println(io.stdout);
  println(io.stdout, 'Modes:');
  const modeWidth = Math.max(...Object.keys(POLICY_MODES).map((m) => m.length));
  for (const [mode, meaning] of Object.entries(POLICY_MODES)) {
    println(io.stdout, `  ${mode.padEnd(modeWidth)}  ${meaning}`);
  }
  println(io.stdout);
  println(
    io.stdout,
    'People are never restricted. A frame can override the mode for what is inside it (props "openboard.policy": auto, review or locked).',
  );
  return 0;
}

/** Set the default mode, or one agent's mode. */
export async function policySetCommand(
  io: CliIo,
  mode: string,
  options: PolicySetOptions = {},
): Promise<number> {
  const chosen = parseMode(mode);
  const agent = options.agent === undefined ? undefined : agentId(options.agent);
  const root = resolveRoot(io, options.root);
  const current = await settings(io, root);
  const next: ProjectConfig = structuredClone(current.config);
  if (agent === undefined) next.policy.default = chosen;
  else next.policy.agents[agent] = chosen;
  await current.save(next);
  println(
    io.stdout,
    agent === undefined
      ? `Agents without a mode of their own now use ${chosen}.`
      : `Agent ${agent} now uses ${chosen}.`,
  );
  return 0;
}

/** Remove an agent's own mode, so it follows the default again. */
export async function policyUnsetCommand(
  io: CliIo,
  options: PolicySetOptions = {},
): Promise<number> {
  if (options.agent === undefined) {
    throw new CliError('name the agent: openboard policy unset --agent <id>');
  }
  const agent = agentId(options.agent);
  const root = resolveRoot(io, options.root);
  const current = await settings(io, root);
  const fallback = current.config.policy.default;
  if (!(agent in current.config.policy.agents)) {
    println(io.stdout, `Agent ${agent} has no mode of its own; it uses the default, ${fallback}.`);
    return 0;
  }
  const next: ProjectConfig = structuredClone(current.config);
  delete next.policy.agents[agent];
  await current.save(next);
  println(io.stdout, `Agent ${agent} now uses the default, ${fallback}.`);
  return 0;
}
