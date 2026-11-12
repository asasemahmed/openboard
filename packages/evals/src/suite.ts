/** Running many scenarios, repeated, with a scripted baseline beside a real agent. */
import { readFileSync } from 'node:fs';
import { VERSION as SERVER_VERSION } from '@openboard/server';
import {
  MCP_VERSION,
  measureToolSurface,
  type RunScenarioOptions,
  runScenario,
} from './harness.js';
import { scriptedRunner } from './runners/scripted.js';
import {
  DEFAULT_THRESHOLD,
  type RunResult,
  type ScenarioSummary,
  type SuiteSummary,
  summarizeScenario,
  summarizeSuite,
} from './score.js';
import type { Scenario } from './types.js';

/** This package's version, from its package.json. */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export interface ReportMeta {
  runner: string;
  model?: string;
  scenarios: string[];
  repeat: number;
  threshold: number;
  evalsVersion: string;
  mcpVersion: string;
  serverVersion: string;
  node: string;
  tools: number;
  toolsListTokens: number;
  instructionsTokens: number;
  /** Whether the agent got the guide appended to its system prompt. */
  guide: boolean;
  startedAt: string;
  durationMs: number;
}

export interface Report {
  meta: ReportMeta;
  summary: SuiteSummary;
  scenarios: ScenarioSummary[];
  runs: RunResult[];
  /** Scripted reference runs, when the runner was not `scripted`. */
  baseline?: RunResult[];
}

export interface SuiteOptions extends Omit<RunScenarioOptions, 'repeat'> {
  repeat?: number;
  concurrency?: number;
  /** Also run the scripted reference for comparison (default: when the runner is not scripted). */
  baseline?: boolean;
  /** Called as each run finishes. */
  onRun?: (result: RunResult, kind: 'agent' | 'baseline') => void;
}

/** Run `jobs` with at most `limit` at a time, keeping results in job order. */
export async function pool<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await (jobs[index] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, worker));
  return results;
}

export async function runSuite(scenarios: Scenario[], options: SuiteOptions): Promise<Report> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const repeat = Math.max(1, options.repeat ?? 1);
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const withBaseline = options.baseline ?? options.runner.name !== 'scripted';

  const agentJobs = scenarios.flatMap((scenario) =>
    Array.from({ length: repeat }, (_, i) => async () => {
      const result = await runScenario(scenario, { ...options, threshold, repeat: i + 1 });
      options.onRun?.(result, 'agent');
      return result;
    }),
  );
  const baselineJobs = withBaseline
    ? scenarios.map((scenario) => async () => {
        const { model: _model, systemAppend: _system, keep: _keep, ...rest } = options;
        const result = await runScenario(scenario, {
          ...rest,
          runner: scriptedRunner(),
          threshold,
          delayScale: 0.05,
        });
        options.onRun?.(result, 'baseline');
        return result;
      })
    : [];

  const runs = await pool(agentJobs, concurrency);
  const baseline = await pool(baselineJobs, Math.max(concurrency, 4));
  const summaries = scenarios.map((scenario) =>
    summarizeScenario(
      runs.filter((r) => r.scenario === scenario.id),
      withBaseline
        ? baseline.filter((r) => r.scenario === scenario.id)
        : runs.filter((r) => r.scenario === scenario.id),
    ),
  );
  const surface = await measureToolSurface();
  const report: Report = {
    meta: {
      runner: options.runner.name,
      ...(options.model ? { model: options.model } : {}),
      scenarios: scenarios.map((s) => s.id),
      repeat,
      threshold,
      evalsVersion: VERSION,
      mcpVersion: MCP_VERSION,
      serverVersion: SERVER_VERSION,
      node: process.version,
      tools: surface.tools,
      toolsListTokens: surface.toolsListTokens,
      instructionsTokens: surface.instructionsTokens,
      guide: options.systemAppend !== undefined,
      startedAt,
      durationMs: Date.now() - started,
    },
    summary: summarizeSuite(summaries),
    scenarios: summaries,
    runs,
  };
  if (withBaseline) report.baseline = baseline;
  return report;
}
