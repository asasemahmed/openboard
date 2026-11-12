import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RunInput } from '../types.js';
import {
  CLAUDE_BOARD_TOOLS,
  claudeArgs,
  claudeCodeRunner,
  parseClaudeOutput,
} from './claude-code.js';
import { commandRunner, expandTemplate, splitTemplate } from './command.js';
import { mcpConfigJson } from './process.js';

/** Recorded from `claude -p "say ok" --output-format json` (Claude Code 2.1.316). */
const SAMPLE = readFileSync(
  new URL('../fixtures/claude-say-ok.stdout.txt', import.meta.url),
  'utf8',
);

function input(over: Partial<RunInput> = {}): RunInput {
  return {
    prompt: 'Map it',
    cwd: process.cwd(),
    mcp: { command: '/usr/bin/node', args: ['relay.js', '127.0.0.1', '4000'] },
    timeoutMs: 20_000,
    env: process.env,
    signal: new AbortController().signal,
    scenario: {} as RunInput['scenario'],
    connect: async () => {
      throw new Error('not used');
    },
    ...over,
  };
}

describe('claude-code', () => {
  it('parses the recorded JSON result', () => {
    const out = parseClaudeOutput(SAMPLE);
    expect(out).toEqual({
      ok: true,
      finalText: 'OK',
      turns: 1,
      usage: {
        inputTokens: 2 + 3296 + 649,
        outputTokens: 4,
        cachedInputTokens: 3296 + 649,
        costUsd: 0.00066789,
      },
    });
  });

  it('reads the last JSON line when the CLI printed more, and reports errors', () => {
    const noisy = `warning: something\n${SAMPLE.trim()}\n`;
    expect(parseClaudeOutput(noisy).finalText).toBe('OK');
    const pretty = `warning: something\n${JSON.stringify(JSON.parse(SAMPLE), null, 2)}\n`;
    expect(parseClaudeOutput(pretty).turns).toBe(1);
    const failed = parseClaudeOutput(
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 30 }),
    );
    expect(failed.ok).toBe(false);
    expect(failed.turns).toBe(30);
    expect(failed.error).toContain('error_max_turns');
    expect(parseClaudeOutput('').ok).toBe(false);
    expect(parseClaudeOutput('not json').error).toContain('no JSON result');
  });

  it('builds a command line that allows only the board and file tools', () => {
    const args = claudeArgs(input({ model: 'haiku', systemAppend: 'GUIDE' }), '/tmp/mcp.json', {
      maxBudgetUsd: 0.5,
    });
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args.slice(0, 2)).toEqual(['-p', 'Map it']);
    expect(value('--output-format')).toBe('json');
    expect(value('--mcp-config')).toBe('/tmp/mcp.json');
    expect(args).toContain('--strict-mcp-config');
    expect(value('--tools')).toBe('Read,Glob,Grep');
    expect(value('--allowedTools')?.split(',')).toEqual([
      ...CLAUDE_BOARD_TOOLS,
      'Read',
      'Glob',
      'Grep',
    ]);
    expect(CLAUDE_BOARD_TOOLS).toHaveLength(16);
    expect(CLAUDE_BOARD_TOOLS[0]).toBe('mcp__openboard__board_list');
    expect(value('--model')).toBe('haiku');
    expect(value('--append-system-prompt')).toBe('GUIDE');
    expect(value('--max-budget-usd')).toBe('0.5');
    expect(claudeArgs(input(), '/tmp/m.json')).not.toContain('--model');
  });

  it('is unavailable, with a reason, when the CLI is missing', async () => {
    const result = await claudeCodeRunner({ binary: '/nonexistent/claude-cli' }).available();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not installed');
  });

  it('writes an mcpServers config for stdio and HTTP', () => {
    expect(JSON.parse(mcpConfigJson({ command: 'node', args: ['r.js'] }))).toEqual({
      mcpServers: { openboard: { type: 'stdio', command: 'node', args: ['r.js'] } },
    });
    expect(JSON.parse(mcpConfigJson({ url: 'http://127.0.0.1:1/mcp' }))).toEqual({
      mcpServers: { openboard: { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
    });
  });
});

describe('command', () => {
  it('splits a template like a shell, without one', () => {
    expect(splitTemplate(`agent run -p {prompt} --config "{mcpConfig}" 'a b' c\\ d ""`)).toEqual([
      'agent',
      'run',
      '-p',
      '{prompt}',
      '--config',
      '{mcpConfig}',
      'a b',
      'c d',
      '',
    ]);
    expect(() => splitTemplate('agent "open')).toThrow('unterminated');
  });

  it('expands placeholders inside words and drops optional groups with an empty one', () => {
    const words = splitTemplate(
      'agent -p {prompt} [--model {model}] --mcp={mcpConfig} [--x] [--sys {system}]',
    );
    expect(
      expandTemplate(words, { prompt: 'do it now', model: '', mcpConfig: '/c.json', system: 'S' }),
    ).toEqual(['agent', '-p', 'do it now', '--mcp=/c.json', '--x', '--sys', 'S']);
    expect(expandTemplate(words, { prompt: 'p', model: 'm', mcpConfig: '/c', system: '' })).toEqual(
      ['agent', '-p', 'p', '--model', 'm', '--mcp=/c', '--x'],
    );
    expect(() => expandTemplate(['[--a', 'b'], {})).toThrow('unclosed');
  });

  it('runs the command in the project with the config file and reports its output', async () => {
    const script = [
      'const fs = require("node:fs");',
      'const [prompt, config, cwd] = process.argv.slice(1);',
      'const mcp = JSON.parse(fs.readFileSync(config, "utf8"));',
      'console.log(JSON.stringify({ prompt, server: mcp.mcpServers.openboard.command, cwdOk: process.cwd() === cwd }));',
    ].join(' ');
    const runner = commandRunner({
      template: `${process.execPath} -e '${script}' {prompt} {mcpConfig} {cwd}`,
    });
    expect(runner.name).toBe(`command:${process.execPath.split('/').pop()}`);
    const out = await runner.run(input({ prompt: 'two words' }));
    expect(out.ok).toBe(true);
    expect(JSON.parse(out.finalText ?? '')).toEqual({
      prompt: 'two words',
      server: '/usr/bin/node',
      cwdOk: true,
    });
  });

  it('fails on a non-zero exit, and stops the command on abort', async () => {
    const failing = commandRunner({ template: `${process.execPath} -e 'process.exit(3)'` });
    const failed = await failing.run(input());
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('exit 3');
    const controller = new AbortController();
    const slow = commandRunner({
      template: `${process.execPath} -e 'setTimeout(() => {}, 60000)'`,
    });
    const started = Date.now();
    const pending = slow.run(input({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 100);
    const stopped = await pending;
    expect(stopped.ok).toBe(false);
    expect(stopped.error).toContain('stopped');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
