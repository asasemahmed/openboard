<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <img src="assets/banner-light.svg" alt="OpenBoard — the open canvas for AI agents" width="100%">
  </picture>
</p>

> [!NOTE]
> **This repository is private for now.** OpenBoard is being built in the open-source spirit from the first commit and will be made public under the MIT license once the foundation is ready. Nothing is released yet.

# OpenBoard

OpenBoard is an open canvas that AI agents read and edit over MCP while you edit it in the browser. Run it in a project, and the agent you already use — Claude Code, Cursor, Codex, or any other [MCP](https://modelcontextprotocol.io) client — can map your code, lay out a plan, and keep it current on a board you both see. The board is a typed graph of tasks, decisions, risks, questions and code, saved as a readable file in your repository. OpenBoard does not build agents; it is the shared surface between you and yours.

## What it does

- **A live canvas.** The board runs in your browser and stays in sync with everyone editing it; changes by others, people or agents, are highlighted as they arrive.
- **Agent tools over MCP.** Sixteen `board_*` tools, over stdio or Streamable HTTP, with ready-made setups for Claude Code, Cursor and Codex. Agents read an outline, a slice or just what changed within a token budget, and write whole intents as one validated batch that the layout engine places.
- **Selection as context.** Select cards on the canvas and say "these"; the agent sees what you selected.
- **You stay in control.** Per project and per agent, decide what agents may change on their own; changes to your work wait as proposals you accept or reject. Every change is recorded and can be undone exactly.
- **A conversation on the board.** Agents ask you questions and wait for the answer, read your comments and mentions in their inbox, and reply in the thread.
- **See agents at work.** Agents appear on the canvas with what they are reading, writing or running, claim the nodes they work on so they do not collide, and you can replay how the board came to be.
- **Boards that know the code.** Link a node to a file or a range of lines; when that code changes, the board marks the node for a re-check.
- **Boards in git.** Each board is a deterministic JSON file in `.openboard/`, merged by meaning with a merge driver and summarized for review with `openboard diff`; Mermaid and JSON Canvas import, and export to Markdown, Mermaid, JSON Canvas or SVG.
- **Your own types and templates.** Declare node types with fields for your domain, start boards from eight templates or your own, and extend the server with plugins you load explicitly.
- **Share beyond your machine.** Shared mode lets people and agents elsewhere sign in with invite links and tokens, each with a role enforced on every request.

## Quick start

You need Node.js 22 or newer. From a clone of this repository:

```bash
corepack enable
pnpm install
pnpm build
alias openboard="node $PWD/packages/cli/dist/bin.js"
cd /path/to/your/project
openboard start
```

The board opens in your browser. [Getting started](docs/getting-started.md) walks through the canvas and your first prompts.

## Connect your agent

In your project, run:

```bash
openboard connect
```

It prints the exact setup for Claude Code, Cursor, Codex and any other MCP client. For a setup that also teaches the agent how to work on a board, use the plugin, rule or snippet in [`integrations/`](integrations/README.md).

## How it works

```
  Agents (Claude Code, Cursor, Codex, ...)           You (browser)
            |  MCP: stdio or HTTP                         |  WebSocket
            v                                             v
  +---------------------------------------------------------------+
  |                       openboard server                        |
  |   agent tools  ->  validation + layout  ->  board document    |
  +---------------------------------------------------------------+
                               |
                    .openboard/*.board.json  (in your repo)
```

Three ideas carry the design:

1. **Structure over pixels.** The board is a typed graph. Agents edit meaning; the layout engine places things, and leaves alone what you placed.
2. **Budgeted reads, intent writes.** Agents read an outline, a frame, the selection or what changed, never more than they asked for. They write whole intents that are validated before they land.
3. **The board is shared ground.** People and agents edit the same document. Every change is attributed, others see it as it happens, and board text is treated as data, not as instructions.

## Documentation

- [Getting started](docs/getting-started.md): build, start, connect, first prompts
- [How agents work with a board](docs/agents.md): the read and write paths, selection, cursors, review and undo, comments and questions, identity, trust
- [Tool reference](docs/tools.md): every tool, operation, validation error and type
- [CLI reference](docs/cli.md): every command and flag
- [Board file format](docs/board-format.md): the `.board.json` file and `config.json`, for reviewers and tool authors
- [Boards in git](docs/git.md): merging, readable diffs, reviewing board changes in pull requests
- [Templates](docs/templates.md): the built-in templates, and how people and agents use them
- [Extending OpenBoard](docs/extending.md): declared types, project templates, plugins
- [Evaluating agents](docs/evals.md): the evaluation harness, its baseline, and what it shows
- [Sharing boards](docs/sharing.md): shared mode, invites, roles, running it safely; and [SECURITY.md](SECURITY.md)
- [Integrations](integrations/README.md): Claude Code, Cursor, Codex and generic MCP setups
- [Architecture](docs/ARCHITECTURE.md): how the packages fit together

## Extending

Declare your own node types in `.openboard/config.json`, keep project templates in `.openboard/templates/`, or write a plugin and load it with `openboard start --plugin <module>`; see [Extending OpenBoard](docs/extending.md).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, commands and ground rules.

## License

[MIT](LICENSE)
