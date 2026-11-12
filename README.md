<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <img src="assets/banner-light.svg" alt="OpenBoard — the open canvas for AI agents" width="100%">
  </picture>
</p>

> [!NOTE]
> **This repository is private for now.** OpenBoard is being built in the open-source spirit from the first commit and will be made public under the MIT license once the foundation is ready. Nothing is released yet.

# OpenBoard

OpenBoard is an open canvas that any AI agent can see, edit, and be steered from.

You run one command and a board opens in your browser. The agent you already use — Claude Code, Cursor, Codex, or anything that speaks [MCP](https://modelcontextprotocol.io) — gets tools to read the board, write to it, and react to what you do on it.

We do not build agents. We build the shared surface between you and your agents.

## Why

- **Plans that persist.** Agent plans stop disappearing into chat scrollback and live on a board that stays up to date.
- **Any agent.** Whiteboard features today are closed and tied to one assistant. OpenBoard works with whatever agent you bring.
- **Steer by pointing.** Select nodes, move them, comment on them, approve or reject changes. The agent sees it.
- **See the work.** Every agent and task is visible with live status, including subagents.
- **Boards in git.** Boards are files in your repo. They diff, merge, and review like code.

## How it works

```
  Agents (Claude Code, Cursor, Codex, custom)        You (browser)
            |  MCP                                        |  WebSocket
            v                                             v
  +---------------------------------------------------------------+
  |                       openboard server                        |
  |  MCP layer  ->  Proposals + policies  ->  Board document      |
  +---------------------------------------------------------------+
                               |
                    .openboard/*.board.json  (in your repo)
```

Three ideas carry the design:

1. **Structure over pixels.** The board is a typed graph. Agents edit meaning; the layout engine places things.
2. **Budgeted reads, intent writes.** Agents read an outline, a frame, a selection, or just what changed. They write whole intents that are validated before they land.
3. **You stay in control.** Agent changes arrive as proposals you can accept or reject, with trust set per agent and per area.

## Status

Early development. Nothing is released yet, and the commands and APIs shown here may change.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: the repo will be public, so nothing goes in that could not be published.

## License

[MIT](LICENSE)
