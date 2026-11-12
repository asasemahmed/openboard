/** Scoring maths: weighted checks per run, then spread across repeats and a suite summary. */
import type { CheckOutcome, HumanLogEntry, RunUsage } from './types.js';

export const DEFAULT_THRESHOLD = 0.8;

export interface CheckResult {
  name: string;
  weight: number;
  pass: boolean;
  score: number;
  detail: string;
}

/** A check's outcome as a result: the score is clamped to 0..1 and defaults to pass. */
export function toResult(name: string, weight: number, outcome: CheckOutcome): CheckResult {
  const raw = outcome.score ?? (outcome.pass ? 1 : 0);
  const score = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  return { name, weight, pass: outcome.pass, score, detail: outcome.detail };
}

/** Weighted mean of check scores; 0 with no checks or no weight. */
export function weightedScore(results: CheckResult[]): number {
  const total = results.reduce((sum, r) => sum + Math.max(0, r.weight), 0);
  if (total === 0) return 0;
  return results.reduce((sum, r) => sum + Math.max(0, r.weight) * r.score, 0) / total;
}

export interface CallSummary {
  seq: number;
  tool: string;
  isError: boolean;
  argsTokens: number;
  resultTokens: number;
  durationMs: number;
}

export interface RunResult {
  scenario: string;
  title: string;
  runner: string;
  model?: string;
  /** 1-based repeat number. */
  repeat: number;
  score: number;
  passed: boolean;
  toolCalls: number;
  /** Tokens of board output the agent read (tool results). */
  boardTokensIn: number;
  /** Tokens the agent wrote into tool arguments. */
  boardTokensOut: number;
  /** One-off cost per connection: `tools/list` plus the server instructions. */
  overheadTokens: number;
  connections: number;
  turns?: number;
  usage?: RunUsage;
  durationMs: number;
  checks: CheckResult[];
  calls: CallSummary[];
  human: HumanLogEntry[];
  finalText?: string;
  /** Why the run did not complete normally (agent failure, timeout, setup error). */
  error?: string;
  /** The project directory, when it was kept. */
  keptPath?: string;
}

export interface Stat {
  mean: number;
  median: number;
  min: number;
  max: number;
  /** Population standard deviation; 0 for one value. */
  stdev: number;
  n: number;
}

export function stat(values: number[]): Stat {
  const n = values.length;
  if (n === 0) return { mean: 0, median: 0, min: 0, max: 0, stdev: 0, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const mid = Math.floor(n / 2);
  const median =
    n % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  return {
    mean,
    median,
    min: sorted[0] as number,
    max: sorted[n - 1] as number,
    stdev: Math.sqrt(variance),
    n,
  };
}

export interface ScenarioSummary {
  scenario: string;
  title: string;
  runs: number;
  score: Stat;
  passRate: number;
  toolCalls: Stat;
  /** Read plus written. */
  boardTokens: Stat;
  boardTokensIn: Stat;
  boardTokensOut: Stat;
  durationMs: Stat;
  costUsd?: Stat;
  /** The scripted reference on the same scenario, when it ran. */
  baseline?: { toolCalls: number; boardTokens: number; score: number };
  /** Failed checks across runs: `name: detail` with the repeats it failed in. */
  failures: string[];
  errors: string[];
}

export function summarizeScenario(runs: RunResult[], baseline?: RunResult[]): ScenarioSummary {
  const first = runs[0];
  if (!first) throw new Error('no runs to summarize');
  const costs = runs.map((r) => r.usage?.costUsd).filter((c): c is number => c !== undefined);
  const failures = new Map<string, number[]>();
  for (const run of runs) {
    for (const c of run.checks.filter((c) => !c.pass)) {
      const key = `${c.name}: ${c.detail}`;
      failures.set(key, [...(failures.get(key) ?? []), run.repeat]);
    }
  }
  const summary: ScenarioSummary = {
    scenario: first.scenario,
    title: first.title,
    runs: runs.length,
    score: stat(runs.map((r) => r.score)),
    passRate: runs.filter((r) => r.passed).length / runs.length,
    toolCalls: stat(runs.map((r) => r.toolCalls)),
    boardTokens: stat(runs.map((r) => r.boardTokensIn + r.boardTokensOut)),
    boardTokensIn: stat(runs.map((r) => r.boardTokensIn)),
    boardTokensOut: stat(runs.map((r) => r.boardTokensOut)),
    durationMs: stat(runs.map((r) => r.durationMs)),
    failures: [...failures].map(([key, repeats]) =>
      runs.length > 1 ? `${key} (repeat ${repeats.join(', ')})` : key,
    ),
    errors: runs.filter((r) => r.error).map((r) => `repeat ${r.repeat}: ${r.error}`),
  };
  if (costs.length > 0) summary.costUsd = stat(costs);
  if (baseline && baseline.length > 0) {
    summary.baseline = {
      toolCalls: stat(baseline.map((r) => r.toolCalls)).mean,
      boardTokens: stat(baseline.map((r) => r.boardTokensIn + r.boardTokensOut)).mean,
      score: stat(baseline.map((r) => r.score)).mean,
    };
  }
  return summary;
}

export interface SuiteSummary {
  scenarios: number;
  runs: number;
  /** Mean over scenarios of each scenario's mean score. */
  meanScore: number;
  /** Passed runs over all runs. */
  passRate: number;
  /** Sum over scenarios of each scenario's mean board tokens. */
  totalBoardTokens: number;
  medianBoardTokens: number;
  totalToolCalls: number;
  costUsd?: number;
  baseline?: {
    meanScore: number;
    totalBoardTokens: number;
    medianBoardTokens: number;
    totalToolCalls: number;
    /** Agent board tokens over the reference's, on the same scenarios. */
    tokenRatio: number;
    callRatio: number;
  };
}

export function summarizeSuite(scenarios: ScenarioSummary[]): SuiteSummary {
  const tokens = scenarios.map((s) => s.boardTokens.mean);
  const runs = scenarios.reduce((sum, s) => sum + s.runs, 0);
  const passed = scenarios.reduce((sum, s) => sum + s.passRate * s.runs, 0);
  const summary: SuiteSummary = {
    scenarios: scenarios.length,
    runs,
    meanScore: stat(scenarios.map((s) => s.score.mean)).mean,
    passRate: runs === 0 ? 0 : passed / runs,
    totalBoardTokens: tokens.reduce((sum, t) => sum + t, 0),
    medianBoardTokens: stat(tokens).median,
    totalToolCalls: scenarios.reduce((sum, s) => sum + s.toolCalls.mean, 0),
  };
  const costs = scenarios.map((s) => s.costUsd?.mean).filter((c): c is number => c !== undefined);
  if (costs.length > 0) summary.costUsd = costs.reduce((sum, c) => sum + c, 0);
  const withBaseline = scenarios.filter((s) => s.baseline);
  if (withBaseline.length === scenarios.length && scenarios.length > 0) {
    const base = withBaseline.map((s) => s.baseline as NonNullable<ScenarioSummary['baseline']>);
    const baseTokens = base.reduce((sum, b) => sum + b.boardTokens, 0);
    const baseCalls = base.reduce((sum, b) => sum + b.toolCalls, 0);
    summary.baseline = {
      meanScore: stat(base.map((b) => b.score)).mean,
      totalBoardTokens: baseTokens,
      medianBoardTokens: stat(base.map((b) => b.boardTokens)).median,
      totalToolCalls: baseCalls,
      tokenRatio: baseTokens === 0 ? 0 : summary.totalBoardTokens / baseTokens,
      callRatio: baseCalls === 0 ? 0 : summary.totalToolCalls / baseCalls,
    };
  }
  return summary;
}
