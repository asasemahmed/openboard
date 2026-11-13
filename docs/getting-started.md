# Getting started

From nothing to an agent drawing on a board in your browser. It takes a few minutes, most of them spent in `pnpm install`.

## Requirements

- Node.js 22 or newer. Corepack, which provides pnpm, ships with Node.
- A browser.
- An agent that speaks MCP: Claude Code, Cursor, Codex, or any other MCP client.

## Build it

OpenBoard runs from a source checkout. In the root of your clone of this repository:

```bash
corepack enable
pnpm install
pnpm build
```

The command line tool is now at `packages/cli/dist/bin.js`. Inside the checkout, `pnpm openboard <command>` runs it, but always with the checkout as its working directory. To use it in your own projects, define an alias while you are in the checkout root:

```bash
alias openboard="node $PWD/packages/cli/dist/bin.js"
```

Add the expanded line to your shell profile to keep it. The rest of the documentation writes `openboard`; without the alias, use `node /path/to/openboard/packages/cli/dist/bin.js` instead.

## Start a board

In the project you want a board for:

```bash
cd /path/to/your/project
openboard start
```

`start` is also the default, so `openboard` alone does the same. It prints:

```text
OpenBoard is running at http://127.0.0.1:4747/b/main
Boards: .openboard

Connect an agent (`openboard connect` shows the setup for each agent):
  MCP over HTTP   http://127.0.0.1:4747/mcp
  MCP over stdio  /usr/local/bin/node /path/to/openboard/packages/cli/dist/bin.js mcp --root /path/to/your/project

Press Ctrl+C to stop.
```

and opens the board in your browser. The project root is the nearest directory upward that contains `.openboard/`, else the git root, else the current directory. A project without boards gets an empty board called `main`. If port 4747 is taken, the server uses the next free port.

## Use the canvas

- Press <kbd>N</kbd> for a note or <kbd>T</kbd> for a task at the pointer, select cards and press <kbd>F</kbd> to put them in a frame, and press <kbd>Enter</kbd> to edit a title.
- Drag from a card's edge handle to another card to connect them; the inspector sets the edge type, a node's status, body and links.
- Cards are filled with the colour of their type. Connections an agent made stay out of sight until you point at or select one of their cards (the count in a card's corner says how many it has); the ones you draw always show. The connections button beside the zoom controls shows every connection at once.
- Drag a card to place it yourself. It is then pinned, and automatic layout leaves it where you put it.
- Select cards to show the agent what you mean by "this" or "these".
- <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd> opens search and commands, and <kbd>?</kbd> lists every shortcut.

## Connect an agent

In the project, run:

```bash
openboard connect
```

It prints the setup for Claude Code, Cursor, Codex, Gemini CLI and any other MCP client, with the absolute paths for your machine. `openboard connect claude-code` (or `cursor`, `codex`, `gemini-cli`, `generic`) shows one agent in full. It only prints; it never edits a config file. The canvas shows the same snippets under "Connect an agent" in the top bar.

For Claude Code the quickest route is the command it prints, run in the project:

```bash
claude mcp add openboard -- /usr/local/bin/node /path/to/openboard/packages/cli/dist/bin.js mcp --root /path/to/your/project
```

To also give the agent guidance on working with a board, use the ready-made integrations instead:

- Claude Code: the plugin in [`integrations/claude-code`](../integrations/claude-code/README.md), with the MCP server and a skill.
- Cursor: [`integrations/cursor`](../integrations/cursor/README.md), with the `.cursor/mcp.json` entry and a project rule.
- Codex: [`integrations/codex`](../integrations/codex/README.md), with the `config.toml` entry and an `AGENTS.md` snippet.
- Gemini CLI: [`integrations/gemini-cli`](../integrations/gemini-cli/README.md), with the `.gemini/settings.json` entry and a `GEMINI.md` snippet.
- Anything else: [`integrations/generic`](../integrations/generic/README.md).

The stdio command starts the board server in the background if it is not running, so the agent works whether or not `openboard start` is open.

## Try three prompts

With the board open in the browser, ask your agent:

1. "Map the architecture of this repository on the board: a frame per area, the modules that matter, and how they depend on each other."
2. "Plan adding CSV export on the board: tasks with what done means, the decisions to make, the risks, and the questions only I can answer."
3. Select two or three cards on the canvas, then: "Break these into smaller tasks and connect them to what they depend on."

The agent's changes appear on the canvas as it makes them, already laid out. Move things, edit text, or select a card and ask about it; the agent sees what you changed the next time it uses a tool.

Clients that support MCP prompts also offer `map_codebase` and `plan_work`, which carry the first two requests with more detailed instructions.

## Stay in control

- By default an agent adds to the board freely, but changing or removing what you made waits for your review as a proposal: ghosts on the canvas, and items in the **Review** panel to accept or reject, with a note the agent reads. From the terminal, `openboard proposals`, `openboard accept` and `openboard reject` do the same. **Settings** (or `openboard policy`) sets how strict this is, for all agents or one; a frame's **Agent access** in the inspector does it for what is inside the frame.
- Every change is recorded: the **Activity** panel (or `openboard history`) lists them, and undo takes one back exactly, leaving later changes alone. Agents undo their own mistakes, answer your comments, and ask you questions on the canvas when they need an answer before going on.

- The canvas shows agents while they work: the **Agents** panel lists their sessions, and with the Claude Code plugin's hooks (or `openboard hook` in another tool) it also shows what they run outside the board. **Replay history** in the command palette plays back how the board came to be.

[Staying in control](agents.md#staying-in-control) and [seeing agents work](agents.md#seeing-agents-work) explain the details.

To start a board with a good structure, use a template: `openboard new "CSV export" --template feature-plan`, or ask your agent to (see [Templates](templates.md)). To give the board your own vocabulary, declare node types in `.openboard/config.json` ([Extending OpenBoard](extending.md)).

## Where boards live

```text
your-project/
  .openboard/
    main.board.json     the board: readable, deterministic JSON
    config.json         the review policy, once you change it
    .local/             runtime state: change feed, history, inboxes, server info
```

Commit the `*.board.json` files and `config.json`. They are written with a stable layout so that a change on the board is a small diff, and the running server picks up changes to them from a checkout, merge or editor. `.openboard/.local/` is runtime state: `openboard init` and the server create it with a `.gitignore` of its own so git skips it. The format is described in [board-format.md](board-format.md).

More boards: `openboard new "Release plan"` creates `.openboard/release-plan.board.json`. `openboard boards` lists them. `openboard import flow.mmd` adds a Mermaid flowchart (or a JSON Canvas) to a board, and `openboard export --format markdown` (or `mermaid`, `canvas`, `svg`) writes one out. Run `openboard git setup --diff` once per clone so git merges and diffs boards by meaning; see [Boards in git](git.md).

## Share with others

`openboard start --share` lets people and agents on other machines work on the same boards, each with an invite and a role; `openboard access invite` creates one. See [Sharing boards](sharing.md).

## Stop

- A server started with `openboard start` stops with <kbd>Ctrl</kbd>+<kbd>C</kbd>.
- A server started in the background by an agent keeps running after the agent exits. Stop it with `openboard stop` in the project.
- `openboard status` shows whether a server runs for the project, where, and which boards it has.

## When something is off

```bash
openboard doctor
```

checks the Node.js version, the project root, that `.openboard/` exists and every board file (and `config.json`, if there is one) parses, that the web app is built, that the MCP server loads, whether the server runs and answers, and, in a git repository, that `.openboard/.local` is ignored. Each problem comes with a fix. It exits with status 1 when a check fails.

Next: [how agents work with a board](agents.md), [the tool reference](tools.md), [the CLI reference](cli.md).
