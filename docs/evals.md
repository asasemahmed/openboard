# Evaluating agents on a board

`packages/evals` is a harness that measures how well an agent works through the OpenBoard MCP server. Each **scenario** sets up a small project and board, gives the agent one task, lets it work through the real MCP server and board server, and then scores what happened. It measures two things:

- **Success.** Is the board right at the end, and did the agent get there the way the product intends: reading the canvas selection when told "these", leaving a proposal alone instead of working around it, asking before deleting, catching up with `board_changes` instead of re-reading everything?
- **Cost.** How many tool calls, and how many tokens of board output the agent read (`BOARD IN`) and wrote (`BOARD OUT`).

With those numbers, a change to tool descriptions, rendering, the server instructions or a policy can be judged by running the suite before and after. The harness's own [README](../packages/evals/README.md) has every option and the scenario API.

## Running it

After a build:

```bash
corepack pnpm evals list                       # the scenarios
corepack pnpm evals show respect-review        # what one sets up, asks and checks
corepack pnpm evals run                        # the scripted reference for every scenario
corepack pnpm evals run --runner claude-code --model haiku --scenario plan-feature
corepack pnpm evals run --runner claude-code --tag review --repeat 3 --markdown evals.md
```

`run` uses the `scripted` runner by default: each scenario's reference solution, sent through the same recording proxy an agent would use. It proves every scenario can be solved (each reference must score 1.0, and a test enforces it) and gives the cost of a perfect run. `--runner claude-code` runs Claude Code headless with only the board and file tools allowed, and `--runner command` runs any other agent CLI from a template. With a real agent, every scenario also runs the reference beside it, so the report can compare.

## Reading a report

```text
SCENARIO        SCORE  PASS  CALLS  BOARD IN  BOARD OUT  REF TOKENS  VS REF  COST  TIME
respect-review   1.00  yes       4       358         74         432    1.0x     -  3.1s
```

- **SCORE**: the weighted mean of the scenario's checks, each from 0 to 1. **PASS**: the score reached the threshold (0.8 by default) and the run completed.
- **CALLS**: tool calls the proxy saw. **BOARD IN** and **BOARD OUT**: estimated tokens of tool results the agent read and of the arguments it wrote.
- **REF TOKENS**, **VS REF**: the reference's board tokens, and the agent's over them.
- **COST**, **TIME**: what the runner reported, and the wall time.

Below the table come the failed checks with their details, then a summary that includes the **fixed overhead** every connection pays once: the `tools/list` JSON and the server instructions. `--json` writes everything, down to each call.

## The baseline

The scripted references, measured with the current tools (16 tools):

| Scenario                         | Score | Calls | Board in | Board out |
| -------------------------------- | ----: | ----: | -------: | --------: |
| `map-small-repo`                 |  1.00 |     2 |      107 |       378 |
| `plan-feature`                   |  1.00 |     2 |       74 |       359 |
| `find-and-update-on-large-board` |  1.00 |     3 |      345 |        45 |
| `selection-as-context`           |  1.00 |     2 |      146 |       136 |
| `respect-review`                 |  1.00 |     4 |      358 |        74 |
| `learn-from-rejection`           |  1.00 |     4 |      486 |       113 |
| `ask-before-destructive`         |  1.00 |     4 |      268 |       110 |
| `keep-board-true-to-code`        |  1.00 |     3 |      117 |        58 |
| `shared-board-claims`            |  1.00 |     4 |      189 |        52 |
| `incremental-update`             |  1.00 |     4 |      263 |        64 |
| `untrusted-content`              |  1.00 |     3 |      202 |        48 |
| `notice-mid-run-mention`         |  1.00 |     5 |      264 |        93 |

Mean score 1.00, pass rate 100%. Board tokens: 4,349 in total, 368 median per scenario, over 40 tool calls. Fixed overhead per connection: 3,529 tokens of `tools/list` plus 445 of instructions.

## What the numbers say: fixed cost dominates

A good run of a typical task reads and writes a few hundred tokens of board content; the whole suite of twelve tasks uses about 4,300. Every connection, before its first call, receives about 4,000 tokens of tool definitions and instructions, and many clients send them to the model on every turn. For small tasks the fixed cost is ten times the work.

That is why the tool list has a budget: a test caps `tools/list` at 3,700 tokens, and the server leaves out of it what clients do not need (the JSON Schema `$schema` URL on every input, annotation hints equal to their defaults, an empty `execution` entry). Adding a tool or a sentence to a description is paid on every turn of every session, so it has to earn its place; the scripted suite must stay at 1.0 to show that what was cut was not needed.

## Adding a scenario

Write a file in `packages/evals/src/scenarios/`, add it to `SCENARIOS` in `src/scenarios/index.ts`, and give it a reference that scores 1.0. A scenario has an id, a `setup` that builds the starting board (as the person, or as the agent "from an earlier session"), optionally a scripted `human` who accepts or rejects proposals, answers questions or edits after the agent's n-th call, a `prompt`, weighted `checks` over the final board and the trace of calls, and the `reference`. The [harness README](../packages/evals/README.md#adding-a-scenario) has a complete example and the list of ready-made checks. `corepack pnpm exec vitest run --project evals` runs every reference and fails unless each scores 1.0.

## Limits

Token counts are estimates (four characters per token, the same estimate the server budgets with) and cover board traffic only; the model's real usage, with its system prompt and conversation, comes only from runners that report it. Scores are as good as the checks, which look at structure and at the trace, not at the quality of prose. The simulated person is simple, with fixed delays. Use `--repeat` before trusting a difference between two runs of a real agent.
