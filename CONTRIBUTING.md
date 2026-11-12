# Contributing to OpenBoard

OpenBoard is developed in the open under the [PolyForm Noncommercial License 1.0.0](LICENSE): free to use, change and share for personal and other noncommercial purposes.

Before you send a contribution, read [Licensing your contribution](#licensing-your-contribution): sending one means you agree to it.

## Licensing your contribution

Anyone may use OpenBoard under the PolyForm Noncommercial License, and its maintainer may also offer it under separate commercial licenses. So that your work can be part of both, by submitting a contribution (a pull request, a patch, or any other material you send to this repository) you agree that:

1. **You keep your copyright.** You remain the owner of what you wrote.
2. **You grant the maintainer a license to it.** You grant the maintainer of OpenBoard (the owner of [github.com/asasemahmed/openboard](https://github.com/asasemahmed/openboard)) and anyone the project is later transferred to a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, copy, change, distribute and sublicense your contribution, and to license it under any terms, including the PolyForm Noncommercial License and commercial licenses.
3. **Patents are covered too.** If you hold patents that your contribution would infringe, you grant the same people a license under them to make, use, sell and distribute your contribution as part of OpenBoard.
4. **You have the right to send it.** The contribution is your own work, or you have the right to submit it under these terms. If an employer or anyone else has rights to what you create, you have their permission.

If you do not agree, do not submit the contribution. These terms do not change how you or anyone else may use OpenBoard.

## Ground rules

- **Nothing private in git.** No secrets, tokens, credentials, internal URLs, or personal data — in files or in commit messages. The history is public.
- **No third-party material without a compatible license.** That includes images, copied docs, and pasted code.
- **Research stays local.** The `research/` folder is ignored by git on purpose.

## Where to start

- Pick an [open issue](https://github.com/asasemahmed/openboard/issues). `good first issue` marks small, well-scoped work; `help wanted` marks work nobody has taken.
- Comment on the issue before you start, so two people do not build the same thing. For anything larger than the issue describes, say how you plan to do it first.
- Found a bug or want something that has no issue? Open one. For a bug, include what you did, what you expected, and what happened.
- Report security problems privately, as [SECURITY.md](SECURITY.md) describes, not in a public issue.

## Working on the project

- Keep changes small and focused. One idea per pull request.
- Every feature should serve the loop between a human and their agents. If it does not, it probably belongs in a plugin.

## Commits

Write commit messages that say what changed and why, in the imperative mood: "Add board schema", not "Added" or "Adds".

## Development

You need Node 22 or newer. The repo uses pnpm through Corepack, so there is nothing else to install:

```bash
corepack enable
pnpm install
pnpm build
pnpm test
```

| Command          | What it does                    |
| ---------------- | ------------------------------- |
| `pnpm build`     | Build every package             |
| `pnpm dev`       | Rebuild the libraries on change |
| `pnpm test`      | Run all tests                   |
| `pnpm typecheck` | Type-check everything           |
| `pnpm lint`      | Check formatting and lint rules |
| `pnpm format`    | Fix formatting                  |
| `pnpm evals`     | Run the agent evaluation suite  |

How the pieces fit together is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Read it before making a change that crosses package boundaries.

## Packages

| Path                        | What it is                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/core`             | Schema, operations, the board document, rendering, policy, types, templates, import and export, merge |
| `packages/server`           | The local board server: sync, persistence, layout, the HTTP API, shared mode, plugins                 |
| `packages/sdk`              | `BoardApi` over HTTP, for programs that talk to a running server                                      |
| `packages/mcp`              | The MCP server: the `board_*` tools on top of any `BoardApi`                                          |
| `packages/app`              | The web canvas                                                                                        |
| `packages/cli`              | The `openboard` command                                                                               |
| `packages/evals`            | The evaluation harness for agents on a board ([docs/evals.md](docs/evals.md))                         |
| `examples/plugin-estimates` | An example server plugin ([docs/extending.md](docs/extending.md))                                     |

## Evaluations

`pnpm evals run` runs every scenario's scripted reference against the real MCP server; each must score 1.0, and `corepack pnpm exec vitest run --project evals` enforces it. Run the suite before and after a change to tool descriptions, rendering, the server instructions or a policy, and with a real agent (`--runner claude-code`) when the change is meant to alter behaviour. See [docs/evals.md](docs/evals.md).

## Tool descriptions are budgeted

Everything in the MCP `tools/list` and the server instructions is sent to the model on every turn of every session, so it is the most expensive text in the project. A test in `packages/mcp` caps `tools/list` at a fixed number of tokens (`TOOLS_LIST_TOKEN_CEILING`). A new tool, parameter or sentence has to fit under it: tighten existing wording rather than raising the ceiling, and do not remove information an agent needs to use a tool correctly. The scripted evaluation suite must still score 1.0 after the change.
