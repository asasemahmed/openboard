/**
 * `openboard connect`: how to connect an agent to this project. Read-only:
 * it prints commands and config blocks and never writes a config file.
 */
import { CliError } from '../lib/errors.js';
import { type CliIo, println } from '../lib/io.js';
import { type Launch, mcpLaunch, shellCommand } from '../lib/mcp.js';
import { resolveRoot } from '../lib/project.js';
import { DEFAULT_PORT, findRunningServer } from '../lib/server.js';

export const AGENTS = ['claude-code', 'cursor', 'codex', 'generic'] as const;
export type AgentName = (typeof AGENTS)[number];

export interface ConnectOptions {
  root?: string;
  json?: boolean;
}

export interface AgentSetup {
  label: string;
  /** A command that registers the server, when the agent has one. */
  command?: string;
  /** The config file to edit instead, and what to put in it. */
  file?: string;
  config?: string;
}

export interface ConnectionInfo {
  root: string;
  stdio: Launch;
  http: { url: string; running: boolean };
  agents: Partial<Record<AgentName, AgentSetup>>;
}

function jsonBlock(launch: Launch): string {
  return JSON.stringify(
    { mcpServers: { openboard: { command: launch.command, args: launch.args } } },
    null,
    2,
  );
}

/** TOML basic strings share JSON's escapes for everything a path can hold. */
function tomlBlock(launch: Launch): string {
  return [
    '[mcp_servers.openboard]',
    `command = ${JSON.stringify(launch.command)}`,
    `args = [${launch.args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
  ].join('\n');
}

export function agentSetups(launch: Launch, httpUrl: string): Record<AgentName, AgentSetup> {
  return {
    'claude-code': {
      label: 'Claude Code',
      command: `claude mcp add openboard -- ${shellCommand(launch)}`,
      file: '.mcp.json',
      config: jsonBlock(launch),
    },
    cursor: { label: 'Cursor', file: '.cursor/mcp.json', config: jsonBlock(launch) },
    codex: { label: 'Codex', file: '~/.codex/config.toml', config: tomlBlock(launch) },
    generic: {
      label: 'Any MCP client',
      command: shellCommand(launch),
      config: `stdio: ${shellCommand(launch)}\nHTTP:  ${httpUrl}`,
    },
  };
}

export async function getConnectionInfo(root: string, agent?: AgentName): Promise<ConnectionInfo> {
  const running = await findRunningServer(root);
  const url = `${running?.url ?? `http://127.0.0.1:${DEFAULT_PORT}`}/mcp`;
  const stdio = mcpLaunch(root);
  const all = agentSetups(stdio, url);
  const agents = agent ? { [agent]: all[agent] } : all;
  return { root, stdio, http: { url, running: running !== null }, agents };
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

const flat = (text: string) => text.replace(/\s*\n\s*/g, ' ');

/** Print how to connect `agent` (or every agent, briefly) to this project. */
export async function connectCommand(
  io: CliIo,
  agent: string | undefined,
  options: ConnectOptions = {},
): Promise<number> {
  if (agent !== undefined && !(AGENTS as readonly string[]).includes(agent)) {
    throw new CliError(`unknown agent "${agent}" (choose one of: ${AGENTS.join(', ')})`);
  }
  const root = resolveRoot(io, options.root);
  const info = await getConnectionInfo(root, agent as AgentName | undefined);
  if (options.json) {
    println(io.stdout, JSON.stringify(info, null, 2));
    return 0;
  }

  const httpNote = info.http.running
    ? '(the server is running)'
    : '(while `openboard start` runs; the port may differ)';
  const out = (line = '') => println(io.stdout, line);

  if (agent === undefined) {
    const setups = agentSetups(info.stdio, info.http.url);
    out(`Connect an agent to the boards in ${root}:`);
    out();
    out(`  Claude Code  ${setups['claude-code'].command}`);
    out(`  Cursor       add to .cursor/mcp.json: ${flat(setups.cursor.config ?? '')}`);
    out(`  Codex        add to ~/.codex/config.toml: ${flat(setups.codex.config ?? '')}`);
    out(`  Other        stdio: ${shellCommand(info.stdio)}`);
    out(`               HTTP:  ${info.http.url} ${httpNote}`);
    out();
    out('The stdio command starts the board server when it is not running.');
    out(`Details for one agent: openboard connect <${AGENTS.join('|')}>`);
    return 0;
  }

  const setup = info.agents[agent as AgentName] as AgentSetup;
  out(`${setup.label}, for the boards in ${root}:`);
  out();
  switch (agent) {
    case 'claude-code':
      out('Run in the project:');
      out(indent(setup.command ?? '', '  '));
      out();
      out('Or add this to .mcp.json in the project root:');
      out(indent(setup.config ?? '', '  '));
      break;
    case 'generic':
      out('Over stdio (starts the board server when needed):');
      out(indent(shellCommand(info.stdio), '  '));
      out();
      out(`Over Streamable HTTP ${httpNote}:`);
      out(indent(info.http.url, '  '));
      break;
    default:
      out(`Add this to ${setup.file}:`);
      out(indent(setup.config ?? '', '  '));
      break;
  }
  out();
  out('The server is named "openboard"; its tools start with board_.');
  return 0;
}
