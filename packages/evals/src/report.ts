/** The report as a terminal table, JSON, or Markdown for a pull request. */
import type { ScenarioSummary, Stat } from './score.js';
import type { Report } from './suite.js';

const fixed = (value: number, digits = 2) => value.toFixed(digits);
const int = (value: number) => Math.round(value).toLocaleString('en-US');

function spread(s: Stat, format: (v: number) => string): string {
  if (s.n <= 1 || s.stdev === 0) return format(s.mean);
  return `${format(s.mean)} ±${format(s.stdev)}`;
}

function ratio(value: number, base: number): string {
  if (base === 0) return '-';
  return `${(value / base).toFixed(1)}x`;
}

function money(value: number | undefined): string {
  return value === undefined ? '-' : `$${value.toFixed(value < 0.1 ? 4 : 2)}`;
}

interface Row {
  scenario: string;
  score: string;
  pass: string;
  calls: string;
  tokensIn: string;
  tokensOut: string;
  baseTokens: string;
  vsBase: string;
  cost: string;
  time: string;
}

function rows(report: Report): Row[] {
  return report.scenarios.map((s) => ({
    scenario: s.scenario,
    score: spread(s.score, (v) => fixed(v)),
    pass:
      s.runs > 1 ? `${Math.round(s.passRate * s.runs)}/${s.runs}` : s.passRate === 1 ? 'yes' : 'NO',
    calls: spread(s.toolCalls, (v) => fixed(v, s.runs > 1 ? 1 : 0)),
    tokensIn: spread(s.boardTokensIn, int),
    tokensOut: spread(s.boardTokensOut, int),
    baseTokens: s.baseline ? int(s.baseline.boardTokens) : '-',
    vsBase: s.baseline ? ratio(s.boardTokens.mean, s.baseline.boardTokens) : '-',
    cost: money(s.costUsd?.mean),
    time: `${(s.durationMs.mean / 1000).toFixed(1)}s`,
  }));
}

const HEADERS: Row = {
  scenario: 'SCENARIO',
  score: 'SCORE',
  pass: 'PASS',
  calls: 'CALLS',
  tokensIn: 'BOARD IN',
  tokensOut: 'BOARD OUT',
  baseTokens: 'REF TOKENS',
  vsBase: 'VS REF',
  cost: 'COST',
  time: 'TIME',
};

const KEYS = Object.keys(HEADERS) as Array<keyof Row>;
const NUMERIC = new Set<keyof Row>([
  'score',
  'calls',
  'tokensIn',
  'tokensOut',
  'baseTokens',
  'vsBase',
  'cost',
  'time',
]);

function summaryLines(report: Report): string[] {
  const { summary } = report;
  const lines = [
    `Mean score ${fixed(summary.meanScore)}, pass rate ${Math.round(summary.passRate * 100)}% (${summary.runs} run${summary.runs === 1 ? '' : 's'} of ${summary.scenarios} scenario${summary.scenarios === 1 ? '' : 's'}, threshold ${report.meta.threshold}).`,
    `Board tokens: ${int(summary.totalBoardTokens)} total, ${int(summary.medianBoardTokens)} median per scenario; ${fixed(summary.totalToolCalls, 1)} tool calls${summary.costUsd !== undefined ? `; agent-reported cost ${money(summary.costUsd)}` : ''}.`,
  ];
  if (summary.baseline && report.meta.runner !== 'scripted') {
    lines.push(
      `Reference (scripted): score ${fixed(summary.baseline.meanScore)}, ${int(summary.baseline.totalBoardTokens)} board tokens total, ${int(summary.baseline.medianBoardTokens)} median, ${fixed(summary.baseline.totalToolCalls, 0)} tool calls.`,
      `The agent used ${summary.baseline.tokenRatio.toFixed(1)}x the board tokens and ${summary.baseline.callRatio.toFixed(1)}x the tool calls of the reference.`,
    );
  }
  lines.push(
    `Fixed overhead per connection: ${int(report.meta.toolsListTokens)} tokens of tools/list (${report.meta.tools} tools) + ${int(report.meta.instructionsTokens)} of instructions.`,
  );
  return lines;
}

function failureLines(s: ScenarioSummary): string[] {
  return [...s.errors.map((e) => `error: ${e}`), ...s.failures];
}

function metaLine(report: Report): string {
  const m = report.meta;
  return `runner ${m.runner}${m.model ? `, model ${m.model}` : ''}${m.guide ? ', with guide' : ''}; repeat ${m.repeat}; @openboard/evals ${m.evalsVersion}, mcp ${m.mcpVersion}, server ${m.serverVersion}, node ${m.node}; ${m.startedAt}, ${(m.durationMs / 1000).toFixed(1)}s`;
}

export function formatTable(report: Report): string {
  const table = [HEADERS, ...rows(report)];
  const widths = KEYS.map((key) => Math.max(...table.map((row) => row[key].length)));
  const line = (row: Row) =>
    KEYS.map((key, i) =>
      NUMERIC.has(key)
        ? row[key].padStart(widths[i] as number)
        : row[key].padEnd(widths[i] as number),
    )
      .join('  ')
      .trimEnd();
  const out = table.map(line);
  const failing = report.scenarios.filter((s) => failureLines(s).length > 0);
  if (failing.length > 0) {
    out.push('', 'Failed checks:');
    for (const s of failing) {
      out.push(`  ${s.scenario}`);
      for (const f of failureLines(s)) out.push(`    - ${f}`);
    }
  }
  out.push('', ...summaryLines(report), metaLine(report));
  const kept = report.runs.filter((r) => r.keptPath);
  if (kept.length > 0) {
    out.push('', 'Kept projects (open with `openboard start --root <path>`):');
    for (const r of kept) out.push(`  ${r.scenario}#${r.repeat}: ${r.keptPath}`);
  }
  return `${out.join('\n')}\n`;
}

export function formatJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function formatMarkdown(report: Report): string {
  const m = report.meta;
  const out = [
    `## OpenBoard agent evals: ${m.runner}${m.model ? ` (${m.model})` : ''}`,
    '',
    ...summaryLines(report).map((line) => `- ${line}`),
    '',
    `| ${KEYS.map((key) => HEADERS[key]).join(' | ')} |`,
    `| ${KEYS.map((key) => (NUMERIC.has(key) ? '---:' : '---')).join(' | ')} |`,
    ...rows(report).map(
      (row) =>
        `| ${KEYS.map((key) => cell(key === 'scenario' ? `\`${row[key]}\`` : row[key])).join(' | ')} |`,
    ),
  ];
  const failing = report.scenarios.filter((s) => failureLines(s).length > 0);
  if (failing.length > 0) {
    out.push('', '### Failed checks', '');
    for (const s of failing) {
      out.push(`- \`${s.scenario}\``);
      for (const f of failureLines(s)) out.push(`  - ${cell(f)}`);
    }
  }
  out.push(
    '',
    '<details><summary>Run details</summary>',
    '',
    `- ${metaLine(report)}`,
    `- Scenarios: ${m.scenarios.map((id) => `\`${id}\``).join(', ')}`,
    '- Board tokens are estimates (4 characters per token) of tool arguments (out) and tool results (in) as recorded by the proxy; cost and model tokens come from the runner when it reports them.',
    '',
    '</details>',
    '',
  );
  return out.join('\n');
}
