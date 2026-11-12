/**
 * `openboard-evals`: list, show and run scenarios. Argument parsing and output
 * only; the work is in the harness.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError, Option } from 'commander';
import { prepareProject } from './harness.js';
import { describeScript } from './human.js';
import { formatJson, formatMarkdown, formatTable } from './report.js';
import { claudeCodeRunner } from './runners/claude-code.js';
import { commandRunner } from './runners/command.js';
import { scriptedRunner } from './runners/scripted.js';
import { SCENARIOS, selectScenarios } from './scenarios/index.js';
import { runSuite, VERSION } from './suite.js';
import type { AgentRunner } from './types.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Aborted on Ctrl-C. */
  signal?: AbortSignal;
}

const RUNNERS = ['scripted', 'claude-code', 'command'] as const;

const GUIDE_MARKERS = ['<!-- openboard:guide:start -->', '<!-- openboard:guide:end -->'];

/** The agent guide shipped with the repository, or the given file; only the marked part when marked. */
export function readGuide(file?: string): string {
  const path =
    file ?? fileURLToPath(new URL('../../../integrations/generic/AGENT_GUIDE.md', import.meta.url));
  if (!existsSync(path)) throw new Error(`no guide at ${path}`);
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf(GUIDE_MARKERS[0] as string);
  const end = text.indexOf(GUIDE_MARKERS[1] as string);
  if (start >= 0 && end > start)
    return text.slice(start + (GUIDE_MARKERS[0] as string).length, end).trim();
  return text.trim();
}

function positive(name: string, max = 1000) {
  return (value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max)
      throw new InvalidArgumentError(`${name} must be a whole number from 1 to ${max}`);
    return n;
  };
}

function fraction(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError('must be a number of 0 or more');
  return n;
}

const collect = (value: string, previous: string[] = []) => [
  ...previous,
  ...value.split(',').filter(Boolean),
];

interface RunFlags {
  runner: (typeof RUNNERS)[number];
  scenario?: string[];
  tag?: string[];
  model?: string;
  repeat: number;
  json?: string;
  markdown?: string;
  keep?: boolean;
  concurrency: number;
  commandTemplate?: string;
  guide?: string | boolean;
  timeout?: number;
  threshold?: number;
  baseline: boolean;
  delayScale?: number;
  maxBudgetUsd?: number;
  strict?: boolean;
}

function makeRunner(flags: RunFlags): AgentRunner {
  switch (flags.runner) {
    case 'scripted':
      return scriptedRunner();
    case 'claude-code':
      return claudeCodeRunner(
        flags.maxBudgetUsd !== undefined ? { maxBudgetUsd: flags.maxBudgetUsd } : {},
      );
    case 'command':
      if (!flags.commandTemplate) throw new Error('--runner command needs --command-template');
      return commandRunner({ template: flags.commandTemplate });
  }
}

export function buildProgram(io: CliIo, exit: { code: number }): Command {
  const program = new Command('openboard-evals')
    .description('Measure how well an agent uses an OpenBoard: task success and token cost.')
    .version(VERSION)
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride();

  program
    .command('list')
    .description('List the scenarios')
    .option('--json', 'as JSON')
    .action((flags: { json?: boolean }) => {
      if (flags.json) {
        io.stdout(
          `${JSON.stringify(
            SCENARIOS.map(({ id, title, description, tags }) => ({ id, title, description, tags })),
            null,
            2,
          )}\n`,
        );
        return;
      }
      const width = Math.max(...SCENARIOS.map((s) => s.id.length));
      for (const s of SCENARIOS)
        io.stdout(`${s.id.padEnd(width)}  ${s.title} [${s.tags.join(', ')}]\n`);
    });

  program
    .command('show <scenario>')
    .description(
      'Print a scenario: its prompt, the board and files its setup makes, the person, and the checks',
    )
    .action(async (id: string) => {
      const [scenario] = selectScenarios({ ids: [id] });
      if (!scenario) return;
      const cleanups: Array<() => Promise<unknown>> = [];
      try {
        const { owner, setup, root } = await prepareProject(scenario, {}, cleanups);
        const outline = await owner.outline('main', { maxTokens: 1500 });
        const config = await owner.getConfig();
        const { readdir } = await import('node:fs/promises');
        const files = (await readdir(root, { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile() && !entry.parentPath.includes('.openboard'))
          .map((entry) =>
            `${entry.parentPath.slice(root.length + 1)}/${entry.name}`.replace(/^\//, ''),
          );
        const lines = [
          `${scenario.id}: ${scenario.title}`,
          scenario.description,
          `Tags: ${scenario.tags.join(', ')}`,
          '',
          'Prompt:',
          `  ${scenario.prompt}`,
          '',
          `Policy: ${config.policy.default}`,
          `Files: ${files.length > 0 ? files.sort().join(', ') : 'none'}`,
          'Board after setup:',
          ...outline.text.split('\n').map((l) => `  ${l}`),
          '',
          'The person:',
          ...describeScript(scenario.human).map((l) => `  ${l}`),
          '',
          'Checks (weight):',
          ...scenario.checks.map((c) => `  ${c.weight}  ${c.name}`),
        ];
        if (scenario.budget) lines.push('', `Budget: ${JSON.stringify(scenario.budget)}`);
        if (Object.keys(setup.metrics).length > 0)
          lines.push(`Metrics: ${JSON.stringify(setup.metrics)}`);
        io.stdout(`${lines.join('\n')}\n`);
      } finally {
        for (const fn of cleanups.reverse()) await fn().catch(() => {});
      }
    });

  program
    .command('run')
    .description('Run scenarios with a runner and report scores and board tokens')
    .addOption(
      new Option('--runner <runner>', 'who does the task').choices(RUNNERS).default('scripted'),
    )
    .option('--scenario <ids>', 'scenario id (repeatable, or comma-separated)', collect)
    .option('--tag <tags>', 'only scenarios with this tag (repeatable)', collect)
    .option('--model <model>', 'model for the runner')
    .option('--repeat <n>', 'runs per scenario', positive('--repeat', 100), 1)
    .option('--json <file>', 'write the full report as JSON')
    .option('--markdown <file>', 'write a Markdown report')
    .option('--keep', 'keep each project directory and print its path')
    .option('--concurrency <n>', 'scenarios at a time', positive('--concurrency', 32), 1)
    .option(
      '--command-template <template>',
      'for --runner command: the agent command line with placeholders',
    )
    .option(
      '--guide [file]',
      'append the agent guide (default: integrations/generic/AGENT_GUIDE.md) to the system prompt',
    )
    .option('--timeout <seconds>', 'per-run timeout', positive('--timeout', 3600))
    .option('--threshold <score>', 'score needed to pass (default 0.8)', fraction)
    .option('--no-baseline', 'do not run the scripted reference beside a real agent')
    .option('--delay-scale <factor>', 'multiply the simulated person’s delays', fraction)
    .option('--max-budget-usd <amount>', 'for --runner claude-code: spending cap per run', fraction)
    .option('--strict', 'exit 1 unless every run passes')
    .action(async (flags: RunFlags) => {
      const scenarios = selectScenarios({
        ...(flags.scenario ? { ids: flags.scenario } : {}),
        ...(flags.tag ? { tags: flags.tag } : {}),
      });
      if (scenarios.length === 0) throw new Error('no scenario matches');
      const runner = makeRunner(flags);
      const available = await runner.available();
      if (!available.ok) {
        io.stderr(
          `The ${runner.name} runner is not available: ${available.reason ?? 'unknown reason'}\n`,
        );
        exit.code = 2;
        return;
      }
      const systemAppend = flags.guide
        ? readGuide(typeof flags.guide === 'string' ? flags.guide : undefined)
        : undefined;
      io.stderr(
        `Running ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} with ${runner.name}${flags.model ? ` (${flags.model})` : ''}...\n`,
      );
      const report = await runSuite(scenarios, {
        runner,
        ...(flags.model ? { model: flags.model } : {}),
        repeat: flags.repeat,
        concurrency: flags.concurrency,
        ...(flags.keep ? { keep: true } : {}),
        ...(systemAppend !== undefined ? { systemAppend } : {}),
        ...(flags.timeout ? { timeoutMs: flags.timeout * 1000 } : {}),
        ...(flags.threshold !== undefined ? { threshold: flags.threshold } : {}),
        baseline: flags.baseline && runner.name !== 'scripted',
        ...(flags.delayScale !== undefined ? { delayScale: flags.delayScale } : {}),
        ...(io.signal ? { signal: io.signal } : {}),
        onRun: (result, kind) =>
          io.stderr(
            `  ${kind === 'baseline' ? 'reference ' : ''}${result.scenario}#${result.repeat}: ${result.score.toFixed(2)}${result.passed ? '' : ' (failed)'} in ${(result.durationMs / 1000).toFixed(1)}s${result.keptPath ? `, kept at ${result.keptPath}` : ''}\n`,
          ),
      });
      io.stdout(formatTable(report));
      if (flags.json) await writeFile(flags.json, formatJson(report));
      if (flags.markdown) await writeFile(flags.markdown, formatMarkdown(report));
      if (flags.strict && report.summary.passRate < 1) exit.code = 1;
      if (io.signal?.aborted) exit.code = 130;
    });

  return program;
}

/** Run the CLI; resolves to the exit code. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  const exit = { code: 0 };
  const program = buildProgram(io, exit);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('commander.')) {
      const exitCode = (error as { exitCode?: number }).exitCode ?? 1;
      return code === 'commander.helpDisplayed' || code === 'commander.version' ? 0 : exitCode;
    }
    io.stderr(`openboard-evals: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return exit.code;
}
