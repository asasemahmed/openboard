# CLI reference

The `openboard` command starts the board server, manages boards, and connects agents. It is built to `packages/cli/dist/bin.js` in a source checkout; [Getting started](getting-started.md#build-it) shows how to make it available as `openboard`. Inside the checkout, `pnpm openboard <command>` runs it with the checkout as the working directory.

```text
openboard [command] [options]
```

| Command               | What it does                                                        |
| --------------------- | ------------------------------------------------------------------- |
| [`start`](#start)     | Start the server in the foreground and open the board (the default) |
| [`init`](#init)       | Create `.openboard/` with an empty board                            |
| [`status`](#status)   | Show whether the server is running, and the boards                  |
| [`stop`](#stop)       | Stop the server running for this project                            |
| [`boards`](#boards)   | List boards                                                         |
| [`new`](#new)         | Create a board                                                      |
| [`export`](#export)   | Write a board as JSON or text                                       |
| [`doctor`](#doctor)   | Check the installation and the project                              |
| [`mcp`](#mcp)         | Serve the boards to an MCP client over stdio                        |
| [`connect`](#connect) | Show how to connect an agent (writes nothing)                       |

Global options: `-v`, `--version` prints the version; `-h`, `--help` shows help, also after a command (`openboard export --help`).

## Common behaviour

**Project root.** Every command except `init` works on a project root. `--root <dir>` names it. Without `--root`, it is the nearest directory upward from the current directory that contains `.openboard/`, else the nearest one that contains `.git`, else the current directory. A `--root` that does not exist is an error.

**Running server or files.** `boards`, `new`, `export` and `status` go through the running server when there is one for the project, so they see unsaved live state, and read or write `.openboard/` directly when there is none.

**Errors and exit codes.** A failure prints one line, `openboard: <message>`, on stderr and exits with status 1. Set `OPENBOARD_DEBUG=1` to also print stack traces, and the server's log lines for `start`.

## start

```text
openboard start [--root <dir>] [-p, --port <n>] [--host <host>] [--board <id>] [--no-open]
```

Start the board server for the project in the foreground and keep it running until <kbd>Ctrl</kbd>+<kbd>C</kbd> (SIGINT or SIGTERM). It serves the web canvas, the HTTP API, document sync for browsers, and MCP over Streamable HTTP at `/mcp`. `openboard` with no command runs `start`.

| Option             | Default     | Meaning                                                                                                                                                                                     |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--root <dir>`     | discovered  | Project root                                                                                                                                                                                |
| `-p`, `--port <n>` | `4747`      | Preferred port, 0 to 65535. If it is taken, the next free port is used.                                                                                                                     |
| `--host <host>`    | `127.0.0.1` | Interface to bind. On anything other than a loopback address, the server stops checking that requests name a loopback host; there is no authentication, so only bind to networks you trust. |
| `--board <id>`     | none        | Open this board in the browser instead of the default view. An unknown id is an error.                                                                                                      |
| `--no-open`        | opens       | Do not open a browser. A newly started server also skips the browser when stdout is not a terminal.                                                                                         |

If the project has no boards, `start` creates `main`, named after the project directory. If a server is already running for the project, `start` prints its URL, opens the browser (unless `--no-open`) and exits. If the web app has not been built, the server starts without it and says so.

```text
$ openboard start --no-open
OpenBoard is running at http://127.0.0.1:4747/b/main
Boards: .openboard

Connect an agent (`openboard connect` shows the setup for each agent):
  MCP over HTTP   http://127.0.0.1:4747/mcp
  MCP over stdio  /usr/local/bin/node /path/to/openboard/packages/cli/dist/bin.js mcp --root /path/to/project

Press Ctrl+C to stop.
```

```text
$ openboard start --no-open
OpenBoard is already running at http://127.0.0.1:4747
```

## init

```text
openboard init [--root <dir>]
```

Create `.openboard/` with `.local/.gitignore` and an empty `main` board in the current directory, or in `--root`. Unlike other commands, `init` does not search upward for a project root: it initializes exactly that directory. Safe to run again; it never overwrites a board, and adds `main` only when there are no boards.

```text
$ openboard init
Created .openboard
Created .openboard/.local/.gitignore
Created .openboard/main.board.json
$ openboard init
Already initialized: .openboard
```

You rarely need `init`: `start` and `mcp` create the same files when they are missing.

## status

```text
openboard status [--root <dir>] [--json]
```

Whether a server is running for the project, and its boards.

```text
$ openboard status
OpenBoard is running at http://127.0.0.1:4748 (pid 46770)
Root: /path/to/project

ID            NAME          NODES  EDGES  UPDATED
main          proj             18      9  2026-11-12T04:47:59.542Z
release-plan  Release plan      1      0  2026-11-12T04:47:59.584Z
```

`--json` prints `{ running, url, pid, port, root, initialized, boards }`, with `url`, `pid` and `port` set to `null` when no server runs, and each board as `{ id, name, nodeCount, edgeCount, updatedAt }`.

## stop

```text
openboard stop [--root <dir>]
```

Stop the server recorded for the project: SIGTERM, then SIGKILL if it has not stopped within 5 seconds. Prints `Stopped OpenBoard (pid N).`, or `OpenBoard is not running.` (exit status 0) when there is nothing to stop. Use it for servers that agents started in the background.

## boards

```text
openboard boards [--root <dir>] [--json]
```

List the project's boards as a table (`ID`, `NAME`, `NODES`, `EDGES`, `UPDATED`). `--json` prints the board summaries as an array. With no boards: `No boards yet. Create one with: openboard new <name>`.

## new

```text
openboard new <name> [--root <dir>] [--id <id>] [--description <text>] [--json]
```

Create an empty board and print its id.

| Option                 | Meaning                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `<name>`               | Board name, 1 to 120 characters                                                      |
| `--id <id>`            | Board id; by default derived from the name (`"Release plan"` becomes `release-plan`) |
| `--description <text>` | Board description, at most 2000 characters                                           |
| `--json`               | Print the new board's summary as JSON                                                |

```text
$ openboard new "Spikes" --description "Throwaway experiments"
Created board spikes
$ openboard new "Spikes"
openboard: a board with id "spikes" already exists
```

## export

```text
openboard export [board] [--root <dir>] [-f, --format <format>] [-o, --out <file>]
```

Write a board to stdout or a file.

| Option                    | Default                     | Meaning                                                         |
| ------------------------- | --------------------------- | --------------------------------------------------------------- |
| `[board]`                 | the only board, else `main` | Board id. With several boards and none called `main`, name one. |
| `-f`, `--format <format>` | from `--out`, else `json`   | `json`, `outline` or `text`                                     |
| `-o`, `--out <file>`      | stdout                      | Write to this file; `-` means stdout                            |

| Format    | Output                                                              | Extension that selects it |
| --------- | ------------------------------------------------------------------- | ------------------------- |
| `json`    | The board file, byte for byte as it is saved in `.openboard/`       | `.json`                   |
| `outline` | Frames and counts by type and status, as `board_outline` shows them | `.outline.txt`            |
| `text`    | Every node at full detail, as `board_read` shows it                 | `.txt`                    |

Exports are not tied to an agent session, so their text shows `cursor 0` and has no budget.

```text
$ openboard export --format outline
Board main "proj", cursor 0: 18 nodes, 9 edges, 3 frames.
Frames (counts are direct children):
[frame] n_cgfi6dcohk "CSV export": 3 task, 1 decision, 1 question, 1 risk; 2 todo, 1 in_progress
[frame] n_yjnyxn6dne "Orders domain": 2 code
[frame] n_ehr4r8game "HTTP API": 2 code, 1 note, 1 risk
Not in a frame: 3 frame, 2 note, 1 question
$ openboard export -o main.outline.txt
Wrote main.outline.txt
```

## doctor

```text
openboard doctor [--root <dir>] [--json]
```

Check the installation and the project. Each line is `ok`, `warn` or `FAIL`, and every warning and failure has a `fix:` line. Exits with status 1 when any check fails; warnings do not fail.

| Check           | Fails or warns when                                            |
| --------------- | -------------------------------------------------------------- |
| Node.js version | Older than 22 (fail)                                           |
| Project root    | It cannot be determined (fail)                                 |
| `.openboard/`   | Missing (fail; fix: `openboard init`)                          |
| Board files     | None (warn), or one does not parse (fail, with the reason)     |
| Web app         | Not built (fail; fix: `pnpm build`)                            |
| MCP server      | Does not load (fail)                                           |
| Server          | Not running (warn), or recorded but not answering (fail)       |
| Git             | In a git repository, `.openboard/.local` is not ignored (fail) |

```text
$ openboard doctor
ok    Node.js 24.22.1
ok    Project root: /path/to/project
ok    .openboard/ exists
ok    .openboard/team-a.board.json parses
ok    .openboard/team-b.board.json parses
ok    Web app is built
ok    MCP server loads (8 tools)
warn  Server is not running
      fix: start it with `openboard start`

Everything looks good.
```

`--json` prints `{ ok, checks: [{ status, label, hint? }] }`.

## mcp

```text
openboard mcp [--root <dir>] [--board <id>]
```

Serve the project's boards to an MCP client over stdio. MCP clients run this command; you do not run it by hand. Stdout carries only protocol messages; messages go to stderr.

| Option         | Meaning                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `--root <dir>` | Project root. Without it, discovered from the working directory the client starts the command in.    |
| `--board <id>` | Board that tool calls use when they name none. See [the default board](agents.md#the-default-board). |

On start it creates `.openboard/` with an empty `main` board if the project has no boards, and starts the board server in the background (`openboard start --no-open`) if none is running. It does not wait for the server before answering the client's handshake; the first tool call waits, up to 15 seconds. If the server goes away mid-session, the next call starts it again and retries once. The background server outlives the session; stop it with `openboard stop`.

Environment: `OPENBOARD_AGENT_ID` and `OPENBOARD_AGENT_NAME` set the identity that the session's changes are attributed to; see [identity](agents.md#identity).

## connect

```text
openboard connect [agent] [--root <dir>] [--json]
```

Print how to connect an agent to this project. It only prints; it never writes a config file. `agent` is one of `claude-code`, `cursor`, `codex` or `generic`; without it, every agent is shown in brief.

All setups launch `openboard mcp` with absolute paths: the Node.js binary running `connect`, this checkout's `bin.js`, and `--root` set to the project. They work from any directory and keep working while you are in another project.

| Agent         | What it prints                                                                          |
| ------------- | --------------------------------------------------------------------------------------- |
| `claude-code` | A `claude mcp add openboard -- ...` command, and the same server as a `.mcp.json` block |
| `cursor`      | A block for `.cursor/mcp.json`                                                          |
| `codex`       | A `[mcp_servers.openboard]` table for `~/.codex/config.toml`                            |
| `generic`     | The stdio command, and the Streamable HTTP URL                                          |

```text
$ openboard connect codex
Codex, for the boards in /path/to/project:

Add this to ~/.codex/config.toml:
  [mcp_servers.openboard]
  command = "/usr/local/bin/node"
  args = ["/path/to/openboard/packages/cli/dist/bin.js", "mcp", "--root", "/path/to/project"]

The server is named "openboard"; its tools start with board_.
```

The HTTP URL is the running server's, or `http://127.0.0.1:4747/mcp` with a note that the port may differ when no server runs. `--json` prints `{ root, stdio: { command, args }, http: { url, running }, agents }`, where `agents` holds the selected agent (or all of them) as `{ label, command?, file?, config? }`.

Ready-made integrations that also give the agent guidance are in [`integrations/`](../integrations/README.md).
