# OpenBoard for OpenCode

Two pieces: an MCP server entry that gives OpenCode the `board_*` tools, and an `AGENTS.md` snippet that tells it how to use them. This setup uses the [OpenCode V2 MCP format](https://opencode.ai/docs/mcp-servers/) (`mcp.servers`), not the V1 format. The setup below was checked with OpenCode v2.4.0.

## 1. Add the MCP server

Use Node.js 22 or later. If you have a fresh OpenBoard checkout, run `pnpm install` and `pnpm build` in that checkout first. Then open a shell in the separate project whose boards you want to use:

```bash
REPO=/absolute/path/to/openboard
NODE="$(command -v node)"
BIN="$REPO/packages/cli/dist/bin.js"
PROJECT="$PWD"
"$NODE" "$BIN" connect opencode --root "$PROJECT"
```

If you already have `openboard` on your path, run `openboard connect opencode` from the project instead. `connect` only prints the configuration; it does not write files or start a server. It fills in absolute paths for Node, the CLI, and your project. Add `--json` to get the same block as the string `agents.opencode.config`.

If you have no project config, paste the printed block into `opencode.json` at the project root. If you already have `opencode.json` or `opencode.jsonc`, merge only the `mcp.servers.openboard` entry into that file, preserving your other settings and servers. [`opencode.json`](opencode.json) here shows the format with placeholder paths. The generated paths are machine-specific.

## 2. Add the instructions

Append [`AGENTS.md`](AGENTS.md) from this directory to the project's own `AGENTS.md`, creating it if needed. Leave any existing instructions in place and add a blank line before the snippet. If the file already has an OpenBoard guide between `<!-- openboard:guide:start -->` and `<!-- openboard:guide:end -->`, replace that section instead of adding a second copy.

```bash
{
  if [ -s AGENTS.md ]; then printf '\n\n'; fi
  cat "$REPO/integrations/opencode/AGENTS.md"
} >> AGENTS.md
```

OpenCode [loads project `AGENTS.md` automatically](https://opencode.ai/docs/instructions/). The marked snippet has no machine-specific settings and is safe to commit.

## Verify

Use a private OpenCode server for both the connection check and the prompt. On v2.4.0, a fresh `--standalone` process can report `No MCP servers configured` before the project MCP server finishes loading. A prompt run needs a working model/provider in OpenCode.

```bash
opencode --version
export OPENCODE_PASSWORD="$(node -p 'crypto.randomUUID()')"
opencode serve --hostname 127.0.0.1 --port 0 &
OPENCODE_PID=$!
```

In the same project shell, set `URL` to the loopback URL printed by `serve`. Run the list command again if the server is still loading. Once `openboard` shows as `connected`, run the prompt against that same server:

```bash
opencode mcp list --server "$URL"
```

```bash
PROMPT='Use the OpenBoard MCP server to call board_outline for board main. Do not use shell, filesystem tools, or web tools to obtain or fabricate the result. Report the actual outline and the heading of the OpenBoard project guidance already supplied to you.'
opencode run --server "$URL" --format json --archived --auto "$PROMPT"
```

The MCP list is a connection check; the tool result in the run is the end-to-end check. On a fresh project it begins with `Board main` and includes `0 nodes, 0 edges, 0 frames` and an empty-board summary. The reply should also identify the project guide heading `Working on the OpenBoard board`.

When finished, stop that private server with `kill "$OPENCODE_PID"`, then `unset OPENCODE_PASSWORD`.

The MCP command starts the board server on the first board tool call if it is not already running. You do not need `openboard start` unless you want the browser canvas. If the tool cannot reach the board server, run `openboard doctor` in the project (or `"$NODE" "$BIN" doctor --root "$PROJECT"` with the checkout CLI).

## Connect to a shared server

On the machine hosting the [shared board](../../docs/sharing.md), create an agent grant with `openboard access invite --agent`. On the machine running OpenCode, generate the bridge entry using the board server's base URL, without `/mcp`:

```bash
"$NODE" "$BIN" connect opencode --remote --url https://board.example.com
```

Merge it into the OpenCode project's config instead of the local entry. It launches a local stdio bridge (`openboard mcp --url`) that sends tool calls to the shared board rather than opening a local one. Export `OPENBOARD_TOKEN` with the grant token before starting a fresh standalone or new OpenCode process that inherits the environment. Keep `{env:OPENBOARD_TOKEN}` literally in the JSON: OpenCode resolves it at runtime, so the token does not need to be printed or stored in the config. Use the same tool prompt to check the shared board.

## Remove

Delete only `mcp.servers.openboard` from the project config and the marked OpenBoard section (including its markers) from `AGENTS.md`. Preserve other servers, settings and instructions. Reopen OpenCode and leave `.openboard/` intact to keep your boards. To stop an optional background board server you no longer need, run `"$NODE" "$BIN" stop --root "$PROJECT"`.
