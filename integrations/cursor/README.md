# OpenBoard for Cursor

Two files: the MCP server entry that gives Cursor's agent the `board_*` tools, and a project rule that tells it how to use them.

## 1. Add the MCP server

In your project, print the exact block for your machine:

```bash
openboard connect cursor
```

(`openboard` is the alias from [Getting started](../../docs/getting-started.md#build-it); without it, run `node /path/to/openboard/packages/cli/dist/bin.js connect cursor` in the project.)

Paste the printed block into `.cursor/mcp.json` in the project root. If the file already has an `mcpServers` object, add the `openboard` entry to it. [`mcp.json`](mcp.json) in this directory shows the shape, with placeholders where the printed block has absolute paths:

| Placeholder                                            | Printed value                                   |
| ------------------------------------------------------ | ----------------------------------------------- |
| `/absolute/path/to/node`                               | The Node.js binary that ran `openboard connect` |
| `/absolute/path/to/openboard/packages/cli/dist/bin.js` | The CLI in your checkout                        |
| `/absolute/path/to/your/project`                       | The project root whose boards the server serves |

The paths are specific to your machine, so keep `.cursor/mcp.json` out of the repository or let each person generate their own. To make the entry available in every project instead, put it in `~/.cursor/mcp.json` and add one entry per project, each with its own name and `--root`.

The stdio server starts the board server in the background when it is not running. To use a running server over HTTP instead, see [the generic instructions](../generic/README.md#streamable-http).

## 2. Add the rule

Copy [`openboard.mdc`](openboard.mdc) to `.cursor/rules/openboard.mdc` in the project:

```bash
mkdir -p .cursor/rules
cp /path/to/openboard/integrations/cursor/openboard.mdc .cursor/rules/
```

The rule has `alwaysApply: false` and a description, so the agent loads it when a request is about the board. The rule holds no paths and can be committed. Its text is the same as [`../generic/AGENT_GUIDE.md`](../generic/AGENT_GUIDE.md).

## Verify

- The `openboard` server is enabled where Cursor lists its MCP servers, and its twelve tools (`board_list` to `board_undo`) appear among the agent's available tools.
- If it does not start, open the Output panel, choose "MCP Logs", and run `openboard doctor` in the project.
- Start the canvas with `openboard start` and ask the agent: "Show me the outline of the board."

## Remove

Delete the `openboard` entry from `.cursor/mcp.json` and delete `.cursor/rules/openboard.mdc`. Your boards in `.openboard/` are not touched.
