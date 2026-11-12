# Integrations

Ready-made setups for connecting an agent to OpenBoard. Each one works from a built source checkout.

| Directory                      | For            | What it contains                                                         |
| ------------------------------ | -------------- | ------------------------------------------------------------------------ |
| [`claude-code/`](claude-code/) | Claude Code    | A plugin: the MCP server entry, the `board` skill and the activity hooks |
| [`cursor/`](cursor/)           | Cursor         | The `.cursor/mcp.json` entry, a project rule and activity hooks          |
| [`codex/`](codex/)             | Codex          | The `config.toml` entry, an `AGENTS.md` snippet and activity hooks       |
| [`generic/`](generic/)         | Any MCP client | stdio and Streamable HTTP setup, and a client-agnostic guide             |

`.claude-plugin/marketplace.json` makes this directory a local Claude Code plugin marketplace; see [`claude-code/README.md`](claude-code/README.md).

## The operating guide

Every integration ships the same guidance on how to work with a board.

- The full version is the Claude Code skill, [`claude-code/skills/board/SKILL.md`](claude-code/skills/board/SKILL.md). It is the canonical wording.
- The condensed version is derived from it and is identical, word for word, in three files: [`generic/AGENT_GUIDE.md`](generic/AGENT_GUIDE.md), [`cursor/openboard.mdc`](cursor/openboard.mdc) and [`codex/AGENTS.md`](codex/AGENTS.md).

When you change the guidance, change the skill first, then update the condensed text in all three files. This prints nothing when they agree:

```bash
cd integrations
extract() { awk '/openboard:guide:start/{f=1;next}/openboard:guide:end/{f=0}f' "$1"; }
extract generic/AGENT_GUIDE.md > /tmp/guide-generic.md
extract codex/AGENTS.md > /tmp/guide-codex.md
tail -n +6 cursor/openboard.mdc > /tmp/guide-cursor.md
cmp /tmp/guide-generic.md /tmp/guide-codex.md && cmp /tmp/guide-codex.md /tmp/guide-cursor.md
```
