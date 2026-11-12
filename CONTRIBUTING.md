# Contributing to OpenBoard

Thanks for helping. You do not need to know the whole codebase: most issues touch one or two files, and each one says where to look.

## Your first contribution

1. **Pick something.** Start with a [`good first issue`](https://github.com/asasemahmed/openboard/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22), or [`help wanted`](https://github.com/asasemahmed/openboard/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) for something bigger. Have an idea instead? Start a [discussion](https://github.com/asasemahmed/openboard/discussions).
2. **Say you are on it.** Leave a comment on the issue, so two people do not build the same thing.
3. **Set it up.** You need Node.js 22 or newer:

   ```bash
   git clone https://github.com/asasemahmed/openboard.git
   cd openboard
   corepack enable
   pnpm install
   pnpm build
   ```

   If `corepack enable` is not allowed on your machine, put `corepack` in front of every `pnpm` command instead (`corepack pnpm install`).

4. **Make the change.** Keep it small: one idea per pull request. Before you send it, run:

   ```bash
   pnpm test
   pnpm lint        # pnpm format fixes most of what it finds
   pnpm typecheck
   ```

5. **Open a pull request.** Say what you changed and how you checked it, and tick the box for the [contribution terms](#the-contribution-terms-in-short). A draft pull request is fine if you want early feedback.

Stuck, or not sure what is wanted? Ask in the issue or in a discussion. No question is too small.

## Three rules

- **Nothing private.** No secrets, tokens, passwords or personal data, in files or in commit messages. The history is public.
- **Only what you may share.** Your own work, or material under a license that allows it (images, docs and code included).
- **Security problems go private.** Report them as [SECURITY.md](SECURITY.md) describes, not in a public issue.

## The contribution terms, in short

OpenBoard is free for noncommercial use under the [PolyForm Noncommercial License](LICENSE), and its maintainer may also sell commercial licenses. When you send a contribution:

- you keep the copyright in your work;
- you let the maintainer use your work in OpenBoard under any license, paid ones included;
- you confirm the work is yours to give.

That is all. The full wording is below, in [Licensing your contribution](#licensing-your-contribution).

## Useful commands

| Command          | What it does                    |
| ---------------- | ------------------------------- |
| `pnpm build`     | Build every package             |
| `pnpm dev`       | Rebuild the libraries on change |
| `pnpm test`      | Run all tests                   |
| `pnpm typecheck` | Type-check everything           |
| `pnpm lint`      | Check formatting and lint rules |
| `pnpm format`    | Fix formatting                  |
| `pnpm evals`     | Run the agent evaluation suite  |

To try your change in the browser, run `node packages/cli/dist/bin.js start` in any folder.

## Where things are

| Path                        | What it is                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/app`              | The web canvas                                                                                        |
| `packages/core`             | Schema, operations, the board document, rendering, policy, types, templates, import and export, merge |
| `packages/server`           | The local board server: sync, persistence, layout, the HTTP API, shared mode, plugins                 |
| `packages/mcp`              | The MCP server: the `board_*` tools on top of any `BoardApi`                                          |
| `packages/cli`              | The `openboard` command                                                                               |
| `packages/sdk`              | `BoardApi` over HTTP, for programs that talk to a running server                                      |
| `packages/evals`            | The evaluation harness for agents on a board ([docs/evals.md](docs/evals.md))                         |
| `integrations/`             | Ready-made setups for specific agents                                                                 |
| `examples/plugin-estimates` | An example server plugin ([docs/extending.md](docs/extending.md))                                     |

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the packages fit together. You only need it for a change that crosses packages.

## Only if you change what agents see

Most contributions can skip this section. It applies when you change an MCP tool, its description, the server instructions, rendering for agents, or a review policy.

- **Run the evaluations.** `pnpm evals run` runs every scenario against the real MCP server, and each must still score 1.0 (`corepack pnpm exec vitest run --project evals` checks it). If the change is meant to alter how agents behave, run it with a real agent too (`--runner claude-code`). See [docs/evals.md](docs/evals.md).
- **Keep tool descriptions short.** Tool descriptions and the server instructions are sent to the model on every turn, so a test in `packages/mcp` caps them at a fixed number of tokens (`TOOLS_LIST_TOKEN_CEILING`). If something new does not fit, tighten existing wording rather than raising the cap, without removing what an agent needs.

## Licensing your contribution

Anyone may use OpenBoard under the PolyForm Noncommercial License, and its maintainer may also offer it under separate commercial licenses. So that your work can be part of both, by submitting a contribution (a pull request, a patch, or any other material you send to this repository) you agree that:

1. **You keep your copyright.** You remain the owner of what you wrote.
2. **You grant the maintainer a license to it.** You grant the maintainer of OpenBoard (the owner of [github.com/asasemahmed/openboard](https://github.com/asasemahmed/openboard)) and anyone the project is later transferred to a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, copy, change, distribute and sublicense your contribution, and to license it under any terms, including the PolyForm Noncommercial License and commercial licenses.
3. **Patents are covered too.** If you hold patents that your contribution would infringe, you grant the same people a license under them to make, use, sell and distribute your contribution as part of OpenBoard.
4. **You have the right to send it.** The contribution is your own work, or you have the right to submit it under these terms. If an employer or anyone else has rights to what you create, you have their permission.

If you do not agree, do not submit the contribution. These terms do not change how you or anyone else may use OpenBoard.
