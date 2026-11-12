import { describe, expect, it } from 'vitest';
import { formatJson, formatMarkdown, formatTable } from './report.js';
import {
  type RunResult,
  stat,
  summarizeScenario,
  summarizeSuite,
  toResult,
  weightedScore,
} from './score.js';
import type { Report } from './suite.js';

function run(scenario: string, repeat: number, over: Partial<RunResult> = {}): RunResult {
  return {
    scenario,
    title: scenario,
    runner: 'claude-code',
    repeat,
    score: 1,
    passed: true,
    toolCalls: 4,
    boardTokensIn: 300,
    boardTokensOut: 100,
    overheadTokens: 4000,
    connections: 1,
    durationMs: 2000,
    checks: [],
    calls: [],
    human: [],
    ...over,
  };
}

describe('scores', () => {
  it('clamps check scores and defaults them to pass or fail', () => {
    expect(toResult('a', 1, { pass: true, detail: '' }).score).toBe(1);
    expect(toResult('a', 1, { pass: false, detail: '' }).score).toBe(0);
    expect(toResult('a', 1, { pass: false, score: 1.7, detail: '' }).score).toBe(1);
    expect(toResult('a', 1, { pass: false, score: Number.NaN, detail: '' }).score).toBe(0);
  });

  it('weights checks', () => {
    const results = [
      toResult('a', 3, { pass: true, detail: '' }),
      toResult('b', 1, { pass: false, detail: '' }),
    ];
    expect(weightedScore(results)).toBe(0.75);
    expect(weightedScore([toResult('half', 2, { pass: false, score: 0.5, detail: '' })])).toBe(0.5);
    expect(weightedScore([])).toBe(0);
  });

  it('computes spread', () => {
    expect(stat([])).toEqual({ mean: 0, median: 0, min: 0, max: 0, stdev: 0, n: 0 });
    const s = stat([1, 2, 3, 6]);
    expect(s.mean).toBe(3);
    expect(s.median).toBe(2.5);
    expect(s.min).toBe(1);
    expect(s.max).toBe(6);
    expect(s.stdev).toBeCloseTo(Math.sqrt(3.5));
    expect(stat([5]).stdev).toBe(0);
  });

  it('summarizes repeats of a scenario against the baseline', () => {
    const failing = {
      name: 'asked first',
      weight: 2,
      pass: false,
      score: 0,
      detail: 'board_ask never happened',
    };
    const runs = [
      run('s', 1, { score: 1, usage: { costUsd: 0.02 } }),
      run('s', 2, {
        score: 0.5,
        passed: false,
        checks: [failing],
        boardTokensIn: 900,
        usage: { costUsd: 0.04 },
      }),
    ];
    const summary = summarizeScenario(runs, [
      run('s', 1, { runner: 'scripted', boardTokensIn: 150, boardTokensOut: 50, toolCalls: 2 }),
    ]);
    expect(summary.runs).toBe(2);
    expect(summary.score.mean).toBe(0.75);
    expect(summary.passRate).toBe(0.5);
    expect(summary.boardTokens.mean).toBe(700);
    expect(summary.costUsd?.mean).toBeCloseTo(0.03);
    expect(summary.baseline).toEqual({ toolCalls: 2, boardTokens: 200, score: 1 });
    expect(summary.failures).toEqual(['asked first: board_ask never happened (repeat 2)']);
  });

  it('summarizes a suite with the ratio to the reference', () => {
    const a = summarizeScenario(
      [run('a', 1, { boardTokensIn: 900, boardTokensOut: 100, toolCalls: 6 })],
      [run('a', 1, { boardTokensIn: 400, boardTokensOut: 100, toolCalls: 3 })],
    );
    const b = summarizeScenario(
      [run('b', 1, { score: 0.5, passed: false, boardTokensIn: 100, boardTokensOut: 50 })],
      [run('b', 1, { boardTokensIn: 50, boardTokensOut: 50 })],
    );
    const suite = summarizeSuite([a, b]);
    expect(suite.meanScore).toBe(0.75);
    expect(suite.passRate).toBe(0.5);
    expect(suite.totalBoardTokens).toBe(1150);
    expect(suite.medianBoardTokens).toBe(575);
    expect(suite.totalToolCalls).toBe(10);
    expect(suite.baseline?.totalBoardTokens).toBe(600);
    expect(suite.baseline?.tokenRatio).toBeCloseTo(1150 / 600);
    expect(suite.baseline?.callRatio).toBeCloseTo(10 / 7);
    // Without a baseline for every scenario there is no ratio.
    expect(summarizeSuite([summarizeScenario([run('c', 1)])]).baseline).toBeUndefined();
  });
});

describe('the report', () => {
  const failing = {
    name: 'asked first',
    weight: 2,
    pass: false,
    score: 0,
    detail: 'board_ask | never happened',
  };
  const runs = [
    run('alpha', 1, { usage: { costUsd: 0.0123 } }),
    run('beta', 1, { score: 0.4, passed: false, checks: [failing], keptPath: '/tmp/kept' }),
  ];
  const scenarios = [
    summarizeScenario(
      [runs[0] as RunResult],
      [run('alpha', 1, { boardTokensIn: 100, boardTokensOut: 100 })],
    ),
    summarizeScenario(
      [runs[1] as RunResult],
      [run('beta', 1, { boardTokensIn: 100, boardTokensOut: 100 })],
    ),
  ];
  const report: Report = {
    meta: {
      runner: 'claude-code',
      model: 'haiku',
      scenarios: ['alpha', 'beta'],
      repeat: 1,
      threshold: 0.8,
      evalsVersion: '0.0.0',
      mcpVersion: '0.0.0',
      serverVersion: '0.0.0',
      node: 'v24.0.0',
      tools: 14,
      toolsListTokens: 3656,
      instructionsTokens: 378,
      guide: false,
      startedAt: '2026-11-12T00:00:00.000Z',
      durationMs: 12_345,
    },
    summary: summarizeSuite(scenarios),
    scenarios,
    runs,
  };

  it('prints a table with failures, the comparison and the kept paths', () => {
    const text = formatTable(report);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(
      /^SCENARIO\s+SCORE\s+PASS\s+CALLS\s+BOARD IN\s+BOARD OUT\s+REF TOKENS\s+VS REF\s+COST\s+TIME$/,
    );
    expect(lines[1]).toMatch(
      /^alpha\s+1\.00\s+yes\s+4\s+300\s+100\s+200\s+2\.0x\s+\$0\.0123\s+2\.0s$/,
    );
    expect(lines[2]).toMatch(/^beta\s+0\.40\s+NO/);
    expect(text).toContain('    - asked first: board_ask | never happened');
    expect(text).toContain(
      'The agent used 2.0x the board tokens and 1.0x the tool calls of the reference.',
    );
    expect(text).toContain(
      'Fixed overhead per connection: 3,656 tokens of tools/list (14 tools) + 378 of instructions.',
    );
    expect(text).toContain('runner claude-code, model haiku; repeat 1');
    expect(text).toContain('beta#1: /tmp/kept');
  });

  it('writes Markdown for a pull request, escaping table cells', () => {
    const md = formatMarkdown(report);
    expect(md).toContain('## OpenBoard agent evals: claude-code (haiku)');
    expect(md).toContain('| SCENARIO | SCORE | PASS |');
    expect(md).toContain('| --- | ---: | --- |');
    expect(md).toContain('| `alpha` | 1.00 | yes | 4 | 300 | 100 | 200 | 2.0x | $0.0123 | 2.0s |');
    expect(md).toContain('  - asked first: board_ask \\| never happened');
    expect(md).toContain('<details><summary>Run details</summary>');
  });

  it('writes JSON that round-trips', () => {
    expect(JSON.parse(formatJson(report))).toEqual(JSON.parse(JSON.stringify(report)));
  });

  it('shows spread with repeats', () => {
    const repeated = [run('r', 1, { score: 1 }), run('r', 2, { score: 0.5, passed: false })];
    const s = summarizeScenario(repeated);
    const text = formatTable({
      ...report,
      scenarios: [s],
      summary: summarizeSuite([s]),
      runs: repeated,
    });
    expect(text).toMatch(/^r\s+0\.75 ±0\.25\s+1\/2/m);
  });
});
