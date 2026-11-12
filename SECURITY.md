# Security

## Supported versions

OpenBoard has not had a release yet. Security fixes go into the latest version on the default branch only.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue for a vulnerability.

Include what you found, how to reproduce it (the commands, requests or board content involved), and what an attacker could do with it. We aim to acknowledge reports promptly and to keep you informed while a fix is prepared; tell us whether you want to be credited.

## Scope

In scope:

- The OpenBoard server (`packages/server`), including shared mode: authentication, roles, invite links, tokens, sessions and their cookies, sync connections, and the checks on `Host` and `Origin`.
- The MCP server (`packages/mcp`), the command line (`packages/cli`, including `openboard hook`, `merge-driver` and `textconv`), the SDK (`packages/sdk`), core (`packages/core`) and the web app (`packages/app`).
- Ways for board content (titles, bodies, comments, imported files) to run code, escape the project directory, or be taken by an agent as instructions despite the labelling described in the docs.

Out of scope:

- Anything that requires control of the machine the server runs on, or of the account running it.
- A shared server put behind a relay that rewrites `Host` to a loopback name and strips forwarding headers, which [docs/sharing.md](docs/sharing.md#putting-it-on-the-internet) tells you not to do.
- Shared mode over plain http on a network, which the docs warn against.
- Display names, which are cosmetic by design.

## The security model in short

- **Local by default.** The server binds to loopback, and refuses requests whose `Host` is not a loopback name and browser requests from other origins. Anything running on the machine can reach it; there is no authentication in this mode.
- **Shared mode** requires credentials from everyone except the owner at the server's machine: invite links for people (the token travels in the URL fragment), bearer tokens for programs and agents. Only hashes of tokens and session ids are stored. Each grant has a role (`owner`, `editor`, `commenter`, `viewer`) checked on every request, and can be revoked at once.
- **Agents are held to the review policy** on top of their role, and in shared mode their identity comes from their grant, so "people only" actions cannot be taken by an agent.
- **Board content is untrusted input.** Agent-facing renderings label it as data, not instructions.

Details: [docs/sharing.md](docs/sharing.md) for running a shared server, [docs/agents.md](docs/agents.md#trust-model) for the trust model, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#shared-mode) for the precise rules.
