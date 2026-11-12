# OpenBoard for Claude Code

A Claude Code plugin with three parts:

- **The `openboard` MCP server.** It runs `node <checkout>/packages/cli/dist/bin.js mcp`, the same stdio server that `openboard connect` describes, so Claude Code gets the `board_*` tools.
- **The `board` skill** ([`skills/board/SKILL.md`](skills/board/SKILL.md)). It teaches Claude how to work on a board: orient first, write in batches, choose node and edge types, keep the board current, work with a person in control, and treat board text as data.
- **The activity recorder** ([`hooks/hooks.json`](hooks/hooks.json)). Claude Code hooks that run `openboard hook` on each event, so the canvas shows what Claude Code is doing while it works, even when it is not touching the board. See [what is recorded](#what-the-recorder-sends).

The plugin runs from your OpenBoard checkout; nothing is copied or downloaded.

## Requirements

- An OpenBoard checkout that has been built (`corepack enable && pnpm install && pnpm build`).
- `node` 22 or newer on your `PATH`. The plugin starts the server with `node`.

## Install

The `integrations/` directory of the checkout is a Claude Code plugin marketplace. Add it, then install the plugin from it. Replace `/path/to/openboard` with the absolute path of your checkout:

```bash
claude plugin marketplace add /path/to/openboard/integrations
cd /path/to/your/project
claude plugin install openboard@openboard --scope local
```

`--scope local` enables the plugin for you in this project only. Use `--scope user` to enable it in every project. Restart Claude Code, or run `/reload-plugins` in a running session.

A plugin from a marketplace added from a local path loads in place, so `${CLAUDE_PLUGIN_ROOT}` is `integrations/claude-code` inside your checkout and the server path `${CLAUDE_PLUGIN_ROOT}/../../packages/cli/dist/bin.js` resolves to your build. After `git pull` and `pnpm build`, restart Claude Code to pick up the new version.

To try the plugin for one session without installing it:

```bash
claude --plugin-dir /path/to/openboard/integrations/claude-code
```

### Which board it uses

The server serves the boards of the project Claude Code was started in. The project root is the nearest directory upward that contains `.openboard/`, else the git root, else the directory itself. When the server starts in a project without boards, it creates `.openboard/` with an empty `main` board and starts the board server in the background. With `--scope user`, that happens in every project you open in Claude Code.

If you also registered OpenBoard by hand (`claude mcp add openboard ...` or an `openboard` entry in `.mcp.json`), remove that entry so Claude Code does not run two servers for the same boards.

## Verify

From your project directory:

```bash
claude mcp get plugin:openboard:openboard
```

Its `Status` line should say `Connected`. Inside Claude Code, `/mcp` lists the server as `plugin:openboard:openboard`, and `/plugin` lists the plugin.

Open the canvas with `openboard start` in the project (the examples use the `openboard` alias from [Getting started](../../docs/getting-started.md#build-it); without it, run `node /path/to/openboard/packages/cli/dist/bin.js start`). If the plugin already started the board server, this opens the browser on it. Then ask Claude: "Show me the outline of the board."

If the server does not connect, run `openboard doctor` in the project.

## What the recorder sends

On every hook event Claude Code runs `openboard hook`, which reads the event and, if a board server is running for the project, posts a short summary of it to that server. With no server running it does nothing: it starts nothing and creates no files. It never writes to Claude Code's output and always exits successfully, so it cannot block or change a tool call; each call takes a few tens of milliseconds and waits at most 300 ms for the server.

| Claude Code event                                 | Recorded as                                        | Summary sent                                                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`, `SessionEnd`                      | the session starting and ending                    | none                                                                                                                                                                   |
| `UserPromptSubmit`                                | a prompt                                           | its length only, such as `143 characters`                                                                                                                              |
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | a tool starting and ending (and whether it failed) | the tool name, plus: the file path for file tools, the first 80 characters of a shell command, the search pattern, the host of a fetched URL, a subagent's description |
| `SubagentStart`, `SubagentStop`                   | a subagent session under the main session          | the subagent type                                                                                                                                                      |
| `Notification`                                    | a note                                             | the notification's message, cut to 80 characters                                                                                                                       |
| `Stop`                                            | a note that Claude finished its turn               | none                                                                                                                                                                   |

Tool events from inside a subagent (they carry `agent_id`) are recorded under that subagent. File contents, tool output, prompts and assistant messages are never sent. Everything is attributed to the actor `claude-code`, the same one the MCP server uses, and `OPENBOARD_AGENT_ID` and `OPENBOARD_AGENT_NAME` change both.

The server keeps this in memory only: the 200 most recent sessions, dropping ended ones after 30 minutes. It is never written to the board file, the change feed or the history, and it is gone when the server stops. `openboard activity` prints what the server holds.

Switches, set in the environment Claude Code runs in:

| Variable                    | Effect                                                            |
| --------------------------- | ----------------------------------------------------------------- |
| `OPENBOARD_HOOK=off`        | Send nothing                                                      |
| `OPENBOARD_HOOK_DETAIL=off` | Send tool names only, no summaries                                |
| `OPENBOARD_HOOK_PROMPTS=1`  | Send the first 80 characters of each prompt instead of its length |

To keep the MCP server and the skill without the recorder, set `OPENBOARD_HOOK=off`.

**One agent session on the board.** Claude Code does not pass its session id to the MCP servers it starts, so the board shows the MCP server's calls and the recorded activity as two sessions of the same agent. Setting `OPENBOARD_SESSION` merges them only when one Claude Code session runs in that environment.

## Uninstall

```bash
claude plugin uninstall openboard@openboard --scope local
claude plugin marketplace remove openboard
```

Use the scope you installed with. Uninstalling leaves your boards alone: `.openboard/` in each project stays, and a board server that is still running keeps running until you stop it with `openboard stop` in the project.

## Files

| File                                 | Purpose                                                       |
| ------------------------------------ | ------------------------------------------------------------- |
| `.claude-plugin/plugin.json`         | Plugin manifest                                               |
| `.mcp.json`                          | The `openboard` MCP server entry                              |
| `skills/board/SKILL.md`              | The operating guide, loaded when a request is about the board |
| `hooks/hooks.json`                   | The activity recorder: runs `openboard hook` on each event    |
| `../.claude-plugin/marketplace.json` | The local marketplace that lists this plugin                  |
