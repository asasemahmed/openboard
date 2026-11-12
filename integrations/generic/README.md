# Connect any MCP client

OpenBoard speaks the Model Context Protocol over two transports. Use stdio unless your client can only reach HTTP servers.

The examples use the `openboard` alias from [Getting started](../../docs/getting-started.md#build-it). Without it, replace `openboard` with `node /path/to/openboard/packages/cli/dist/bin.js`.

## stdio

Print the command for your project:

```bash
openboard connect generic
```

It prints something like:

```text
Over stdio (starts the board server when needed):
  /usr/local/bin/node /path/to/openboard/packages/cli/dist/bin.js mcp --root /path/to/your/project
```

Configure your client to launch that command, with `command` set to the Node.js path and `args` to the rest. In the common `mcpServers` JSON format:

```json
{
  "mcpServers": {
    "openboard": {
      "command": "/usr/local/bin/node",
      "args": [
        "/path/to/openboard/packages/cli/dist/bin.js",
        "mcp",
        "--root",
        "/path/to/your/project"
      ]
    }
  }
}
```

What the stdio server does:

- It serves the boards of the project given by `--root`. Without `--root`, it uses the project around its working directory: the nearest directory upward that contains `.openboard/`, else the git root, else the working directory.
- If the project has no boards, it creates `.openboard/` with an empty `main` board.
- If no board server runs for the project, it starts one in the background (`openboard start --no-open`), and starts it again if it goes away during the session. The board server keeps running after the client disconnects; stop it with `openboard stop`.
- `--board <id>` sets the board that tool calls use when they name none. See [the default board](../../docs/agents.md#the-default-board).
- It writes only protocol messages to stdout and its own messages to stderr.

Changes are attributed to an actor derived from the name the client reports when it connects (`claude-code` becomes "Claude Code"). To choose the identity yourself, set environment variables for the server process:

| Variable               | Effect                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENBOARD_AGENT_ID`   | Actor id, for example `reviewer`. Letters, digits and `_ . : -`, starting with a letter or digit, at most 64 characters. An invalid value is ignored. |
| `OPENBOARD_AGENT_NAME` | Display name shown on the canvas and in change lists, at most 80 characters.                                                                          |

## Streamable HTTP

While a board server runs (`openboard start`, or started by a stdio session), it serves MCP over Streamable HTTP at `<server url>/mcp`. The default URL is `http://127.0.0.1:4747/mcp`; if that port was taken the server picked the next free one, so check with `openboard status` or `openboard connect generic`.

Examples, with the default URL:

```bash
claude mcp add --transport http openboard http://127.0.0.1:4747/mcp
codex mcp add openboard --url http://127.0.0.1:4747/mcp
```

```json
{ "mcpServers": { "openboard": { "url": "http://127.0.0.1:4747/mcp" } } }
```

Differences from stdio:

- The board server must already be running; nothing starts it for you.
- Each MCP session gets its own actor from the client name. `OPENBOARD_AGENT_ID` and `OPENBOARD_AGENT_NAME` do not apply.
- There is no `--board`; the default board rule always applies.
- A session that sends nothing for 30 minutes is closed; the client starts a new one.
- By default the server listens on `127.0.0.1` and accepts only loopback `Host` names, so the client must run on the same machine.

## Instructions for the agent

The tools describe themselves, and the server sends short instructions when a client connects. For better results, add the condensed guide in [`AGENT_GUIDE.md`](AGENT_GUIDE.md) to your agent's instructions.

## Check the connection

Ask the agent to call `board_outline`. A working connection answers with a line like:

```text
Board main "your-project", cursor 0: 0 nodes, 0 edges, 0 frames.
```

If it fails, run `openboard doctor` in the project. The full tool reference is in [docs/tools.md](../../docs/tools.md).
