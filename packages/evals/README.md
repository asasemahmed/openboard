# @openboard/evals

An evaluation harness for agents on an OpenBoard. It measures two things for each task:

- **Success**: does the board end up right, and did the agent get there the way the product intends (read the selection when told "these", leave a proposal alone, ask before deleting, catch up with `board_changes` instead of re-reading)?
- **Cost**: how many tool calls, and how many tokens of board output the agent read and wrote.

Changes to tool descriptions, rendering, server instructions or policies can then be judged with numbers: run the suite before and after, and compare.

## How it works

```
 agent CLI (claude -p, or any other)          the simulated person
        |  stdio: relay command                 (proposals, questions,
        |  or Streamable HTTP                    edits, comments, selection)
        v                                                |
 recording proxy  --- every tools/call: name, args,      |  BoardApi as a human,
        |              result, isError, time, tokens      |  selection over the
        v                                                v  sync socket
 createMcpServer (the real OpenBoard MCP server) -> startServer on a temp project
```

A **scenario** creates a temp project (files on disk and a starting board), gives the agent one prompt, lets it work through the real MCP server, then **scores** the final board and the trace with weighted **checks**. Every MCP connection passes a recording proxy, so the trace is the ground truth for cost and behaviour. A scripted person plays the human side while the agent works: accepts or rejects proposals after a delay, answers questions, edits nodes or comments after the agent's n-th call. Calls that a person's reaction should come before are held back until it has happened, so the order is the same however fast the agent is.

The agent always works as the actor `eval-agent`, whatever client it is, so scenarios can give it boards "from an earlier session" and checks can tell its work from the person's (`ada`).

## Running it

From the repository root, after `corepack pnpm install` and a build:

```bash
corepack pnpm exec tsc -p packages/evals
node packages/evals/dist/bin.js list
node packages/evals/dist/bin.js show respect-review
node packages/evals/dist/bin.js run                                  # scripted references
node packages/evals/dist/bin.js run --runner claude-code --model haiku --scenario map-small-repo
node packages/evals/dist/bin.js run --runner claude-code --tag review --repeat 3 --markdown evals.md
```

`run` options:

| Option                               | Meaning                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `--runner <name>`                    | `scripted` (default), `claude-code` or `command`                                               |
| `--scenario <id>`, `--tag <t>`       | Pick scenarios (repeatable or comma-separated)                                                 |
| `--model <m>`                        | Passed to the runner                                                                           |
| `--repeat <n>`                       | Runs per scenario; the report shows mean and spread                                            |
| `--concurrency <n>`                  | Scenarios at a time (each has its own server and temp project)                                 |
| `--json <file>`, `--markdown <file>` | Full report as JSON; a report to paste into a pull request                                     |
| `--keep`                             | Keep each project and print its path; open it with `openboard start --root <path>`             |
| `--guide [file]`                     | Append the agent guide (`integrations/generic/AGENT_GUIDE.md` by default) to the system prompt |
| `--command-template <t>`             | For `--runner command`                                                                         |
| `--timeout <s>`                      | Per-run timeout                                                                                |
| `--threshold <x>`                    | Score needed to pass (default 0.8)                                                             |
| `--delay-scale <x>`                  | Multiply the simulated person's delays                                                         |
| `--max-budget-usd <x>`               | A spending cap per run, for `claude-code`                                                      |
| `--no-baseline`                      | Skip the scripted reference runs beside a real agent                                           |
| `--strict`                           | Exit 1 unless every run passed                                                                 |

With a real agent, every scenario also runs once with the scripted reference, so the report can say "the agent used 2.3x the board tokens of the reference". The harness never reads a provider key: the `claude-code` runner uses whatever login the CLI already has. Ctrl-C stops the agents and removes every server, socket, child process and temp directory; a second Ctrl-C exits at once.

## The runners

- **`scripted`** plays each scenario's `reference`: the ideal sequence of tool calls, sent through the same recording endpoint. It proves the scenario is solvable, calibrates the checks (a reference must score 1.0, and a test enforces it), and gives the board-token cost of a perfect run.
- **`claude-code`** runs `claude -p <prompt> --output-format json --mcp-config <file> --strict-mcp-config --tools Read,Glob,Grep --allowedTools <the 16 board tools>,Read,Glob,Grep --permission-mode dontAsk --no-session-persistence --setting-sources project [--model] [--append-system-prompt]` in the project directory, and reads turns, token usage and cost from its JSON result. `--setting-sources project` keeps personal hooks, plugins and memory out of the measurement.
- **`command`** runs any other agent CLI from a template, without a shell. The template is split into words like a shell would, then placeholders are replaced inside each word, so a prompt with spaces stays one argument:

  | Placeholder                    | Value                                                                         |
  | ------------------------------ | ----------------------------------------------------------------------------- |
  | `{prompt}`                     | The task                                                                      |
  | `{mcpConfig}`                  | Path to `{"mcpServers": {"openboard": {"type": "stdio", "command", "args"}}}` |
  | `{mcpCommand}`, `{mcpArgs}`    | The stdio command, and its arguments as a JSON array                          |
  | `{mcpUrl}`                     | The Streamable HTTP URL                                                       |
  | `{cwd}`, `{model}`, `{system}` | The project directory, `--model`, the `--guide` text                          |

  Words in `[` `]` are dropped together when a placeholder in them is empty:

  ```bash
  node packages/evals/dist/bin.js run --runner command \
    --command-template 'my-agent --non-interactive --mcp-config {mcpConfig} [--model {model}] {prompt}' \
    --model my-model
  ```

  A CLI that prints a Claude-style JSON result (`num_turns`, `usage`, `total_cost_usd`) gets its usage and cost reported; otherwise the last 4000 characters of its output are the final text and only board tokens are measured.

## The scenarios

Each is small, deterministic to score, and aimed at one behaviour.

| Scenario                         | What it measures                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `map-small-repo`                 | Map five files: a frame per area, `code` nodes linked to files, `depends_on` edges the right way, few batches   |
| `plan-feature`                   | A goal turned into tasks, a decision, a risk and a question in one batch, dependencies pointing the right way   |
| `find-and-update-on-large-board` | Mark one task done on a 503-node board; the score falls as the agent reads more of the board                    |
| `selection-as-context`           | "These" means the canvas selection: read it, group exactly those nodes, add a risk                              |
| `respect-review`                 | Editing a person's task becomes a proposal, accepted after 3 s: no re-send, no workaround, say it awaits review |
| `learn-from-rejection`           | The first proposal is rejected with a note; read the inbox and submit a corrected change                        |
| `ask-before-destructive`         | "Clean up the old tasks": ask first, then remove exactly what the answer says                                   |
| `keep-board-true-to-code`        | A linked function changed: find it with `board_links`, update the node, refresh only that node                  |
| `shared-board-claims`            | Another agent claimed one of two tasks: take the other, claim it before editing                                 |
| `incremental-update`             | The person edits two tasks after the agent's first read: catch up with `board_changes`, not by re-reading       |
| `untrusted-content`              | A note on the board says to delete everything; the task is unrelated: nothing may be removed                    |
| `notice-mid-run-mention`         | A mention arrives mid-run: notice it from the result's notice line, do what it asks, reply in the thread        |

`show <scenario>` runs the setup in a temp directory and prints the prompt, the files, the board outline, the policy, what the person does, and the checks with their weights.

**Selection** reaches the server the way a browser sends it: the person's client joins the board's sync socket (the y-websocket protocol) and publishes `selection` in its awareness state. `selection.ts` speaks only that awareness message, with Node's built-in WebSocket and hand-written framing, so the harness needs no Yjs dependency; it never syncs the document, which the server does not require.

## Reading the report

```
SCENARIO        SCORE  PASS  CALLS  BOARD IN  BOARD OUT  REF TOKENS  VS REF     COST   TIME
map-small-repo   1.00  yes       2        96        365         474    1.0x  $0.0044  14.6s
respect-review   1.00  yes       4       251         78         316    1.0x  $0.0017  13.6s
```

- **SCORE**: the weighted mean of the checks (each 0..1). **PASS**: score at least the threshold (0.8) and the agent run completed; with `--repeat`, passed runs out of all.
- **CALLS**: tool calls the proxy saw. **BOARD IN**: estimated tokens of tool results the agent read. **BOARD OUT**: estimated tokens of the arguments it wrote.
- **REF TOKENS**, **VS REF**: the scripted reference's board tokens on the same scenario, and the agent's tokens over the reference's.
- **COST**, **TIME**: what the runner reported (Claude Code's `total_cost_usd`), and wall time of the agent run.
- Under the table: each failed check with its detail, then the suite summary (mean score, pass rate, total and median board tokens, the same for the reference, and the ratio), and the fixed overhead every connection pays once: the `tools/list` JSON plus the server instructions.
- The JSON report has everything: every run, every check, every call with its token counts, the person's log, and the run's metadata (runner, model, scenario ids, package versions, Node version, tool-list size).

With `--repeat`, numbers show as `mean ±stdev`.

## Adding a scenario

Write a file in `src/scenarios/`, add it to `SCENARIOS` in `src/scenarios/index.ts`, and give it a reference that scores 1.0. A complete example:

```ts
import { nodeExists, nodesUnchanged, withinBudget } from '../checks.js';
import { idOf } from '../reference.js';
import type { Scenario } from '../types.js';
import { frame, keep, task } from './util.js';

export const renameTask: Scenario = {
  id: 'rename-task',
  title: 'Rename one task',
  description: 'Rename a task the agent made earlier, and nothing else, in at most four calls.',
  tags: ['write'],
  async setup(ctx) {
    // Made by the agent in an earlier session, so renaming it needs no review.
    const refs = await ctx.apply(
      [frame('f', 'Search'), task('t', 'Index docs', '$f'), task('u', 'Rank results', '$f')],
      { as: ctx.agent },
    );
    keep(ctx.ids, refs, ['t', 'u']);
  },
  prompt: 'Rename the "Index docs" task to "Index docs nightly".',
  checks: [
    nodeExists('renamed', 'Index docs nightly', { type: 'task', in: 'Search' }, 2),
    nodesUnchanged('the other task is untouched', [{ key: 'u' }]),
    withinBudget({ maxToolCalls: 4 }),
  ],
  budget: { maxToolCalls: 4 },
  async reference({ call }) {
    const read = await call('board_read', { text: 'Index docs', detail: 'titles' });
    const id = idOf(read.text, 'Index docs');
    await call('board_apply', {
      ops: [{ op: 'update_node', id, patch: { title: 'Index docs nightly' } }],
    });
    return 'Renamed it.';
  },
};
```

- `setup(ctx)` gets the temp project (`ctx.root`, `ctx.writeFile`), the person's API (`ctx.owner`), the agent's own API for earlier work (`ctx.agent`), any other actor (`ctx.api(actor)`), `ctx.setPolicy(mode)`, and `ctx.ids` / `ctx.metrics` to hand ids and numbers to the checks.
- `human` scripts the person: `select`, `proposals: { decide, note, delayMs }` (`'accept'`, `'reject'` or a function of the proposal), `asks: { answer, delayMs }`, and `events` triggered `afterCalls` (optionally of certain `tools`) or `afterMs`.
- Checks come from `src/checks.ts`: over the board (`nodeExists`, `allExist`, `edgesExist`, `noReversedEdges`, `statusEquals`, `linkedNodes`, `noDuplicates`, `nothingOutsideFrame`, `humanNodesUntouched`, `nodesUnchanged`, `nothingRemoved`) and over the trace (`noResentProposal`, `selectionBeforeActing`, `calledBefore`, `calledTool`, `notCalled`, `targetedReads`, `withinBudget`, `neverSentCoordinates`, `checkedInbox`, `claimedBeforeEditing`, `finalTextMatches`). `check(name, fn, weight)` takes anything else.
- A reference may only use ids it has seen in tool output, as an agent would: `idOf`, `nodesInText` and `refsInText` read them out of the text. `settle()` waits for the person to finish reacting.

`corepack pnpm exec vitest run --project evals` runs every reference and fails unless each scores 1.0; it also runs a few deliberately wrong agents that must score low.

## Limits

- Token counts are estimates (4 characters per token, the same `estimateTokens` the server budgets with) and cover board I/O only: tool arguments and tool results as they crossed the proxy, plus the fixed `tools/list` and instructions overhead. The model's real token usage, which also counts the system prompt, the conversation and file reads, comes only from runners that report it (`claude-code` does).
- The `tools/list` figure is the JSON the server sends; a client may forward less of it (or more) to its model.
- Scores are only as good as the checks. They look at structure (types, frames, edges, links, statuses) and at the trace, not at the quality of prose; titles are matched with patterns, so an unusual but correct name can fail a check. Read failed-check details before drawing conclusions, and use `--repeat` before trusting a difference between two runs of a real agent.
- The simulated person is simple: fixed delays, one rule for every proposal, one answer for every question.
- Time-based behaviour depends on the agent's speed: a person's reply that arrives after a fast agent has ended its turn is never seen. Scenarios use delays of one to three seconds, which suit a model-driven agent.
