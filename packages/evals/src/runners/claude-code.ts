/**
 * The `claude-code` runner: Claude Code headless (`claude -p`), connected to
 * the recording endpoint and nothing else, allowed the board tools plus
 * Read, Glob and Grep, in the scenario's project directory. Its JSON result
 * gives turns, token usage and cost. The harness never reads a provider key:
 * the CLI uses whatever login it already has.
 */
import { TOOL_NAMES } from '@openboard/mcp';
import type { AgentRunner, RunInput, RunOutput } from '../types.js';
import { runProcess, tail, writeMcpConfig } from './process.js';

export const CLAUDE_FILE_TOOLS = ['Read', 'Glob', 'Grep'] as const;
export const CLAUDE_BOARD_TOOLS = TOOL_NAMES.map((name) => `mcp__openboard__${name}`);

export interface ClaudeCodeOptions {
  /** The CLI to run; defaults to `claude` on PATH. */
  binary?: string;
  /** Appended to the command line, for flags this runner does not know. */
  extraArgs?: string[];
  /** Passed as `--max-budget-usd`. */
  maxBudgetUsd?: number;
}

/** The command line for one run. */
export function claudeArgs(
  input: Pick<RunInput, 'prompt' | 'model' | 'systemAppend'>,
  mcpConfigFile: string,
  options: ClaudeCodeOptions = {},
): string[] {
  const args = [
    '-p',
    input.prompt,
    '--output-format',
    'json',
    '--mcp-config',
    mcpConfigFile,
    '--strict-mcp-config',
    // Only the file-reading tools are built in for this run; the board tools come from MCP.
    '--tools',
    CLAUDE_FILE_TOOLS.join(','),
    '--allowedTools',
    [...CLAUDE_BOARD_TOOLS, ...CLAUDE_FILE_TOOLS].join(','),
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    // Only the (empty) project's settings: no personal hooks, plugins or memory in the measurement.
    '--setting-sources',
    'project',
  ];
  if (input.model) args.push('--model', input.model);
  if (input.systemAppend) args.push('--append-system-prompt', input.systemAppend);
  if (options.maxBudgetUsd !== undefined)
    args.push('--max-budget-usd', String(options.maxBudgetUsd));
  args.push(...(options.extraArgs ?? []));
  return args;
}

interface ClaudeJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Parse `--output-format json` output: one result object (the last JSON line, if there are several). */
export function parseClaudeOutput(stdout: string): RunOutput {
  const text = stdout.trim();
  let parsed: ClaudeJson | undefined;
  // The whole output, each line from the last, or everything from the first brace (a pretty-printed result after a warning).
  const candidates = [
    text,
    ...text.split('\n').reverse(),
    text.slice(Math.max(0, text.indexOf('{'))),
  ];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        parsed = value as ClaudeJson;
        break;
      }
    } catch {
      // Try the next candidate.
    }
  }
  if (!parsed)
    return { ok: false, error: `no JSON result in the output: ${tail(text, 3) || '(empty)'}` };
  const usage = parsed.usage ?? {};
  const cached = (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const out: RunOutput = {
    ok: parsed.is_error !== true && (parsed.subtype === undefined || parsed.subtype === 'success'),
    usage: {
      inputTokens: (usage.input_tokens ?? 0) + cached,
      outputTokens: usage.output_tokens ?? 0,
      cachedInputTokens: cached,
      ...(parsed.total_cost_usd !== undefined ? { costUsd: parsed.total_cost_usd } : {}),
    },
  };
  if (typeof parsed.result === 'string') out.finalText = parsed.result;
  if (typeof parsed.num_turns === 'number') out.turns = parsed.num_turns;
  if (!out.ok)
    out.error = `claude reported ${parsed.subtype ?? 'an error'}${parsed.result ? `: ${parsed.result.slice(0, 300)}` : ''}`;
  return out;
}

export function claudeCodeRunner(options: ClaudeCodeOptions = {}): AgentRunner {
  const binary = options.binary ?? 'claude';
  return {
    name: 'claude-code',
    async available() {
      const result = await runProcess(binary, ['--version'], { timeoutMs: 15_000 });
      if (result.code === 0) return { ok: true };
      return {
        ok: false,
        reason:
          result.code === null && !result.killed
            ? `the ${binary} CLI is not installed or not on PATH`
            : `${binary} --version failed: ${tail(result.stderr || result.stdout, 2)}`,
      };
    },
    async run(input) {
      const config = await writeMcpConfig(input.mcp);
      try {
        const result = await runProcess(binary, claudeArgs(input, config.file, options), {
          cwd: input.cwd,
          env: input.env,
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        });
        const parsed = parseClaudeOutput(result.stdout);
        if (result.killed) {
          return { ...parsed, ok: false, error: 'stopped: timeout or abort' };
        }
        if (result.code !== 0 && parsed.ok) {
          return { ...parsed, ok: false, error: `exit ${result.code}: ${tail(result.stderr)}` };
        }
        if (!parsed.ok && !parsed.usage && result.stderr) {
          return { ...parsed, error: `${parsed.error}; stderr: ${tail(result.stderr)}` };
        }
        return parsed;
      } finally {
        await config.remove();
      }
    },
  };
}
