# OpenBoard for Codex

Two pieces: the MCP server entry that gives Codex the `board_*` tools, and an `AGENTS.md` snippet that tells it how to use them.

## 1. Add the MCP server

In your project, print the exact block for your machine:

```bash
openboard connect codex
```

(`openboard` is the alias from [Getting started](../../docs/getting-started.md#build-it); without it, run `node /path/to/openboard/packages/cli/dist/bin.js connect codex` in the project.)

Paste the printed `[mcp_servers.openboard]` table into `~/.codex/config.toml`. [`config.toml`](config.toml) in this directory shows the shape, with placeholders where the printed block has absolute paths: the Node.js binary, the CLI in your checkout, and the project root.

Alternatively, register the same command with the Codex CLI. Take the command from `openboard connect generic`:

```bash
codex mcp add openboard -- /absolute/path/to/node /absolute/path/to/openboard/packages/cli/dist/bin.js mcp --root /absolute/path/to/your/project
```

`~/.codex/config.toml` applies to every Codex session, and `--root` pins the entry to one project. For several projects, either add one table per project under different names (`[mcp_servers.openboard-api]`, `[mcp_servers.openboard-web]`), or put the table in the project's own `.codex/config.toml`, which Codex reads for trusted projects.

## 2. Add the instructions

Append [`AGENTS.md`](AGENTS.md) from this directory to the `AGENTS.md` at your project root (create it if there is none):

```bash
cat /path/to/openboard/integrations/codex/AGENTS.md >> AGENTS.md
```

The snippet sits between `<!-- openboard:guide:start -->` and `<!-- openboard:guide:end -->`, so you can find and replace it when the guide changes. It holds no paths and can be committed. Its text is the same as [`../generic/AGENT_GUIDE.md`](../generic/AGENT_GUIDE.md).

## 3. Show what the agent is doing (optional)

Codex hooks can report what Codex does to the running board server, so the canvas shows it at work. Codex sends its hook events in the same shape as Claude Code, so [`hooks.json`](hooks.json) runs `openboard hook --format claude-code` on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart` and `SessionEnd`. Put it at `.codex/hooks.json` in the project (or `~/.codex/hooks.json`), replace the placeholders with your absolute paths, and review and trust it with `/hooks` in Codex, which asks before running a new hook. `Stop` and `SubagentStop` are left out because Codex expects those hooks to answer, and the recorder never does.

The command sets `OPENBOARD_AGENT_ID=codex`. Add the same to the MCP server entry so the board shows one agent: `env = { OPENBOARD_AGENT_ID = "codex", OPENBOARD_AGENT_NAME = "Codex" }` in the `[mcp_servers.openboard]` table. What is sent, and how to turn it down or off, is described in [what the recorder sends](../claude-code/README.md#what-the-recorder-sends).

## Verify

```bash
codex mcp list
```

lists `openboard`. In the Codex TUI, `/mcp` shows the server and its tools. Start the canvas with `openboard start` in the project and ask Codex: "Show me the outline of the board." If the server does not start, run `openboard doctor` in the project.

## Remove

```bash
codex mcp remove openboard
```

or delete the `[mcp_servers.openboard]` table by hand, remove the `openboard hook` entries from `.codex/hooks.json`, and remove the marked section from `AGENTS.md`. Your boards in `.openboard/` are not touched.
