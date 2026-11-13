# OpenBoard for Gemini CLI

Two pieces: the MCP server entry that gives Gemini CLI the `board_*` tools, and a `GEMINI.md` snippet that tells it how to use them. Checked with Gemini CLI 0.68.0 (`gemini --version`).

## 1. Add the MCP server

In your project, print the exact block for your machine:

```bash
openboard connect gemini-cli
```

(`openboard` is the alias from [Getting started](../../docs/getting-started.md#build-it); without it, run `node /path/to/openboard/packages/cli/dist/bin.js connect gemini-cli` in the project.)

Paste the printed block into `.gemini/settings.json` in the project root (create the `.gemini` directory if there is none). [`settings.json`](settings.json) in this directory shows the shape, with placeholders where the printed block has absolute paths: the Node.js binary, the CLI in your checkout, and the project root. Keep every server that is already there; the file holds all of them under `mcpServers`.

Alternatively, let Gemini CLI write the entry itself. Take the command from `openboard connect generic`:

```bash
gemini mcp add openboard /absolute/path/to/node /absolute/path/to/openboard/packages/cli/dist/bin.js mcp --root /absolute/path/to/your/project
```

It writes the project's `.gemini/settings.json` by default; `--scope user` puts it in `~/.gemini/settings.json`, which every session reads, so `--root` then pins the entry to one project. For several projects, add one entry per project under its own name (`openboard-api`, `openboard-web`) the same way. Gemini CLI refuses to write in a folder it does not trust yet; trust the folder first (see [Verify](#verify)) or the command stops with `Cannot modify settings in an untrusted workspace`.

## 2. Add the instructions

Append [`GEMINI.md`](GEMINI.md) from this directory to the `GEMINI.md` at your project root (create it if there is none):

```bash
cat /path/to/openboard/integrations/gemini-cli/GEMINI.md >> GEMINI.md
```

Gemini CLI reads `GEMINI.md` as project memory when it starts, so the snippet is loaded without any further setting. The snippet sits between `<!-- openboard:guide:start -->` and `<!-- openboard:guide:end -->`, so you can find and replace it when the guide changes. It holds no paths and can be committed. Its text is the same as [`../generic/AGENT_GUIDE.md`](../generic/AGENT_GUIDE.md).

## Verify

Gemini CLI reads `.gemini/settings.json` and `GEMINI.md` only in a folder it trusts. On the first run it asks whether to trust the project; answer yes, or start it with `GEMINI_CLI_TRUST_WORKSPACE=true`. In an untrusted folder the entry shows as `Disabled` and the memory file is skipped.

```bash
gemini mcp list
```

lists `openboard` with `Connected`. Start the canvas with `openboard start` in the project and ask Gemini CLI: "Show me the outline of the board." If the server does not start, run `openboard doctor` in the project.

## Remove

```bash
gemini mcp remove openboard
```

or delete the `openboard` entry from `.gemini/settings.json` by hand, and remove the marked section from `GEMINI.md`. Your boards in `.openboard/` are not touched.
