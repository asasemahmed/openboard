/**
 * Setup snippets for connecting an agent to this project's board server,
 * built from what `GET /api/info` reports. Pure, so every client's format is
 * tested, including paths with spaces and quotes.
 */
import type { McpInfo } from './api.js';

export type AgentClient = 'claude' | 'cursor' | 'codex' | 'other';

export const AGENT_CLIENTS: ReadonlyArray<{ id: AgentClient; name: string }> = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'codex', name: 'Codex' },
  { id: 'other', name: 'Other' },
];

/** The name the server is registered under in every client's config. */
export const SERVER_NAME = 'openboard';

/** Quote one argument for a POSIX shell. Plain words stay as they are. */
export function shellQuote(arg: string): string {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function shellCommand(stdio: McpInfo['stdio']): string {
  return [stdio.command, ...stdio.args].map(shellQuote).join(' ');
}

/** A TOML basic string. */
export function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** `claude mcp add`, run in the project folder. */
export function claudeCodeCommand(mcp: McpInfo): string {
  return `claude mcp add ${SERVER_NAME} -- ${shellCommand(mcp.stdio)}`;
}

/** The `mcpServers` block used by `.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor). */
export function mcpServersJson(mcp: McpInfo): string {
  const block = {
    mcpServers: {
      [SERVER_NAME]: { command: mcp.stdio.command, args: [...mcp.stdio.args] },
    },
  };
  return JSON.stringify(block, null, 2);
}

/** The `[mcp_servers.openboard]` table for `~/.codex/config.toml`. */
export function codexToml(mcp: McpInfo): string {
  const args = mcp.stdio.args.map(tomlString).join(', ');
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(mcp.stdio.command)}`,
    `args = [${args}]`,
  ].join('\n');
}

export interface Snippet {
  id: string;
  /** What to do with it, shown above the snippet. */
  label: string;
  /** File the snippet belongs in, when it is a config block. */
  file?: string;
  text: string;
}

export function snippetsFor(client: AgentClient, mcp: McpInfo): Snippet[] {
  switch (client) {
    case 'claude':
      return [
        { id: 'claude-cli', label: 'Run this in the project folder', text: claudeCodeCommand(mcp) },
        {
          id: 'claude-json',
          label: 'Or share it with your team in',
          file: '.mcp.json',
          text: mcpServersJson(mcp),
        },
      ];
    case 'cursor':
      return [
        {
          id: 'cursor-json',
          label: 'Add this to',
          file: '.cursor/mcp.json',
          text: mcpServersJson(mcp),
        },
      ];
    case 'codex':
      return [
        {
          id: 'codex-toml',
          label: 'Add this to',
          file: '~/.codex/config.toml',
          text: codexToml(mcp),
        },
      ];
    case 'other':
      return [
        {
          id: 'other-stdio',
          label: 'Command for clients that start the server themselves (stdio)',
          text: shellCommand(mcp.stdio),
        },
        {
          id: 'other-http',
          label: 'URL for clients that connect to a running server (Streamable HTTP)',
          text: mcp.httpUrl,
        },
      ];
  }
}

export interface ExamplePrompt {
  id: string;
  text: string;
}

/** Things to ask an agent once it is connected. `<goal>` is left for the person to fill in. */
export function examplePrompts(boardName: string): ExamplePrompt[] {
  const board = `the OpenBoard board “${boardName}”`;
  return [
    { id: 'map', text: `Map this repository's architecture on ${board}.` },
    { id: 'plan', text: `Plan <goal> on ${board}, as tasks with their dependencies.` },
    {
      id: 'selection',
      text: `Look at what I selected on ${board} and break it down into next steps.`,
    },
  ];
}
