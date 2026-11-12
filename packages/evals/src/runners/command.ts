/**
 * The `command` runner: any agent CLI, from a command template.
 *
 * The template is split into words like a shell would (spaces separate words,
 * '...' and "..." quote, \ escapes outside single quotes) and then each
 * placeholder is replaced inside its word, so a prompt with spaces stays one
 * argument. No shell is involved. Placeholders:
 *
 *   {prompt}     the task prompt
 *   {mcpConfig}  path to a JSON file: {"mcpServers": {"openboard": {...}}}
 *   {mcpCommand} {mcpArgs}  the stdio command, and its arguments as one JSON array
 *   {mcpUrl}     the Streamable HTTP URL
 *   {cwd}        the project directory (also the working directory)
 *   {model}      the --model given to the harness
 *   {system}     the text given with --guide
 *
 * Words between `[` and `]` are dropped together when a placeholder in them is
 * empty: `[--model {model}]`.
 */
import type { AgentRunner, RunInput, RunOutput } from '../types.js';
import { parseClaudeOutput } from './claude-code.js';
import { runProcess, tail, writeMcpConfig } from './process.js';

export function splitTemplate(template: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < template.length) word += template[++i];
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < template.length) {
      word += template[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`unterminated ${quote} in the command template`);
  if (inWord) words.push(word);
  return words;
}

const PLACEHOLDER = /\{(prompt|mcpConfig|mcpCommand|mcpArgs|mcpUrl|cwd|model|system)\}/g;

/** Replace placeholders word by word; drop `[ ... ]` groups with an empty placeholder. */
export function expandTemplate(words: string[], values: Record<string, string>): string[] {
  const out: string[] = [];
  let group: string[] | null = null;
  let groupEmpty = false;
  for (const raw of words) {
    let word = raw;
    const opens = group === null && word.startsWith('[');
    if (opens) {
      group = [];
      groupEmpty = false;
      word = word.slice(1);
    }
    const closes = group !== null && word.endsWith(']');
    if (closes) word = word.slice(0, -1);
    let empty = false;
    const expanded = word.replace(PLACEHOLDER, (_, name: string) => {
      const value = values[name] ?? '';
      if (value === '') empty = true;
      return value;
    });
    if (group !== null) {
      if (empty) groupEmpty = true;
      if (word !== '') group.push(expanded);
      if (closes) {
        if (!groupEmpty) out.push(...group);
        group = null;
      }
    } else {
      out.push(expanded);
    }
  }
  if (group !== null) throw new Error('unclosed [ in the command template');
  return out;
}

export interface CommandRunnerOptions {
  template: string;
  /** Shown in reports; defaults to the program's name. */
  name?: string;
}

export function commandRunner(options: CommandRunnerOptions): AgentRunner {
  const words = splitTemplate(options.template);
  const program = words[0];
  if (!program) throw new Error('the command template is empty');
  return {
    name: options.name ?? `command:${program.split('/').pop()}`,
    async available() {
      return { ok: true };
    },
    async run(input: RunInput): Promise<RunOutput> {
      const config = await writeMcpConfig(input.mcp);
      try {
        const values: Record<string, string> = {
          prompt: input.prompt,
          mcpConfig: config.file,
          mcpCommand: 'command' in input.mcp ? input.mcp.command : '',
          mcpArgs: 'command' in input.mcp ? JSON.stringify(input.mcp.args) : '',
          mcpUrl: 'url' in input.mcp ? input.mcp.url : '',
          cwd: input.cwd,
          model: input.model ?? '',
          system: input.systemAppend ?? '',
        };
        const [command, ...args] = expandTemplate(words, values);
        const result = await runProcess(command as string, args, {
          cwd: input.cwd,
          env: input.env,
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        });
        const parsed = parseClaudeOutput(result.stdout);
        // A CLI that prints a Claude-style JSON result gets its usage reported; anything else is text.
        const structured = parsed.turns !== undefined || parsed.usage?.costUsd !== undefined;
        const output: RunOutput = structured
          ? parsed
          : { ok: true, finalText: result.stdout.trim().slice(-4000) };
        if (result.killed) return { ...output, ok: false, error: 'stopped: timeout or abort' };
        if (result.code !== 0) {
          return {
            ...output,
            ok: false,
            error: `exit ${result.code}: ${tail(result.stderr || result.stdout)}`,
          };
        }
        return output;
      } finally {
        await config.remove();
      }
    },
  };
}
