# Contributing to OpenBoard

OpenBoard is private while the foundation is built and will become a public, MIT-licensed project. Work as if it is already public.

## Ground rules

- **Nothing private in git.** No secrets, tokens, credentials, internal URLs, or personal data — in files or in commit messages. History will be published as-is.
- **No third-party material without a compatible license.** That includes images, copied docs, and pasted code.
- **Research stays local.** The `research/` folder is ignored by git on purpose.

## Working on the project

- Keep changes small and focused. One idea per pull request.
- Every feature should serve the loop between a human and their agents. If it does not, it probably belongs in a plugin.

## Commits

Write commit messages that say what changed and why, in the imperative mood: "Add board schema", not "Added" or "Adds".

## Development

You need Node 22 or newer. The repo uses pnpm through Corepack, so there is nothing else to install:

```bash
corepack enable
pnpm install
pnpm build
pnpm test
```

| Command          | What it does                    |
| ---------------- | ------------------------------- |
| `pnpm build`     | Build every package             |
| `pnpm dev`       | Rebuild the libraries on change |
| `pnpm test`      | Run all tests                   |
| `pnpm typecheck` | Type-check everything           |
| `pnpm lint`      | Check formatting and lint rules |
| `pnpm format`    | Fix formatting                  |

How the pieces fit together is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Read it before making a change that crosses package boundaries.
