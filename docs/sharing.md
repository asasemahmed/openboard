# Sharing boards

By default an OpenBoard server only answers programs on its own machine: you, your browser, and the agents you run. **Shared mode** lets other people, and agents running on other machines, work on the same boards. Everyone except you at the server's machine signs in with an invite, and each invite has a role that caps what it may do.

This page covers when to use it, how to start it, invite people and agents, put it on the internet safely, and what it does and does not protect. The precise rules are in [ARCHITECTURE.md](ARCHITECTURE.md#shared-mode).

## When to use it

- A colleague should see or edit your boards from their own computer.
- An agent runs somewhere else (a CI job, a remote development machine, a hosted agent) and should read or change the boards.

You do not need shared mode for agents on your own machine: `openboard mcp` and `http://127.0.0.1:<port>/mcp` work as before. Shared mode does not replace git: boards are still files in the repository, and teammates can also work on their own copies and merge them (see [Boards in git](git.md)).

## Starting it

```bash
openboard start --share
```

```text
OpenBoard is running at http://127.0.0.1:56353/b/main
Boards: .openboard

Shared mode. People and agents reach it at http://127.0.0.1:56353
Everyone must sign in with an invite, except you at this machine.
Invite someone: openboard access invite (people), openboard access invite --agent (agents).
```

The server still binds to loopback. Other machines reach it through a tunnel or reverse proxy that you put in front ([below](#putting-it-on-the-internet)); tell the server the address they use with `--public-url https://board.example.com`. `--host <interface>` binds another interface directly, which requires `--share` (there is no unauthenticated remote mode), and binding every interface (`0.0.0.0`) also requires `--public-url`. `openboard doctor` shows the mode, the public URL and the number of active grants, and warns when the public URL is plain http on a host other than this machine.

You, at the server's machine, stay the owner without signing in: your browser, the CLI and your local agents work unchanged.

## Inviting people

```bash
openboard access invite --label "Ada's laptop" --role editor
```

prints an invite link, `<public url>/join#<token>`. Send it privately: anyone with the link can sign in with that access. The token sits in the part of the URL after `#`, which browsers never send to the server, proxies or logs. Opening the link signs the person in with a browser session (a cookie) that lasts 30 days or until the grant expires or is revoked. `--expires <hours>` limits the grant; without it, it lasts until revoked. In the canvas, owners also have **Share** in the top bar.

What each role may do (from the rules in `packages/core/src/access.ts`):

| Permission                                                                                                          | owner | editor | commenter | viewer |
| ------------------------------------------------------------------------------------------------------------------- | :---: | :----: | :-------: | :----: |
| Read boards, history, proposals, questions, activity (`board.read`, `presence`, `config.read`)                      |  yes  |  yes   |    yes    |  yes   |
| Comment, ask and answer questions (`comment`, `ask.create`, `ask.answer`)                                           |  yes  |  yes   |    yes    |   no   |
| Create and change boards, undo, decide on proposals (`board.create`, `board.edit`, `board.undo`, `proposal.decide`) |  yes  |  yes   |    no     |   no   |
| Change the review policy, manage access (`config.write`, `access.manage`)                                           |  yes  |   no   |    no     |   no   |

A missing permission is refused with a message that names it, such as `your access (viewer) does not include "board.edit" (change boards); it needs editor access or more`. Deciding on proposals, answering questions and changing the policy are also for people only, and in shared mode that is enforced: an agent's identity comes from its grant, not from what it says about itself.

## Inviting agents

```bash
openboard access invite --agent --label "CI agent" --role editor
```

prints a token, `ob_<grant id>_<secret>`, exactly once: only its hash is kept, so it cannot be shown again. Store it where the agent runs, for example in the environment variable `OPENBOARD_TOKEN` or a secret store. Agent grants can be `editor`, `commenter` or `viewer`, never `owner`.

The agent then connects to `<public url>/mcp` and sends `Authorization: Bearer <token>`:

```bash
claude mcp add --transport http openboard https://board.example.com/mcp --header "Authorization: Bearer ${OPENBOARD_TOKEN}"
```

For MCP clients that only start local commands, the CLI on the agent's machine bridges stdio to the remote server: `OPENBOARD_TOKEN=<token> openboard mcp --url https://board.example.com`. It starts no local server. `openboard connect --remote` prints the setup for Claude Code, Cursor, Codex and other clients, with a placeholder where the token goes. The token is read from the environment only, never from a command-line flag, because flags end up in shell history and process lists.

Everything the agent does is attributed to the grant's actor (`ci-agent-i6caer`), whatever the MCP client calls itself, and its role caps what it may try. The [review policy](agents.md#review-policy) still applies on top: an editor agent's changes to other people's work wait for review as usual, and `openboard policy set <mode> --agent <actor id>` sets its mode. Its activity hooks report to the remote server when `OPENBOARD_URL` and `OPENBOARD_TOKEN` are set.

The CLI uses a remote server the same way: `OPENBOARD_TOKEN=<token> openboard boards --url https://board.example.com`, and `openboard whoami --url ...` says who the server takes you to be. The CLI, `openboard mcp --url` and the hooks send a token only over https, or over plain http to this machine; they refuse a plain http URL of another machine.

## Revoking

```bash
openboard access list
openboard access revoke <id>
```

Revoking takes effect at once: the grant's requests are refused, its browser sessions end, its open connections close, its claims are released and its open questions cancelled. Its pending proposals stay for people to accept or reject. An agent connected over MCP gets a message that its access was revoked or has expired. An expired grant behaves the same way.

## Putting it on the internet

Keep the server bound to loopback and put a TLS-terminating reverse proxy or a tunnel in front of it, then start with `--public-url https://<the address people use>`. With an https public URL the session cookie is marked `Secure`. Do not expose the server over plain http beyond your own machine: tokens and cookies would cross the network unencrypted.

The proxy must pass the real `Host` (the public name) and its forwarding headers (`X-Forwarded-For`, `Forwarded` or similar), as proxies and tunnels normally do. The server trusts a request without credentials as the owner only when it comes from loopback, names a loopback `Host` on its port, and carries no forwarding header; a proxy on the same machine also connects from loopback, and the `Host` and forwarding headers are how the server tells its traffic apart from yours.

**The one configuration to avoid:** a relay on the server's machine that rewrites `Host` to `localhost` (or `127.0.0.1`) and strips every forwarding header. Its traffic looks exactly like a program on your machine, so everyone coming through it would be the owner. Do not run such a relay in front of a shared server. Note that this is what nginx does by default: `proxy_pass http://127.0.0.1:<port>;` alone sends `Host: 127.0.0.1:<port>` and no `X-Forwarded-For`. With nginx, always add `proxy_set_header Host $host;` and `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, then check from another machine that `openboard whoami --url <public url>` without a token is refused.

## What remote viewers can see

Anyone with any role can read everything on every board of the project: nodes, comments, history, proposals, questions, claims (with their notes), and which agents are present and whether they are working, waiting or idle. There are no per-board permissions. Other callers than the owner get no local paths, user names or launch commands from `/api/info` and `/api/health`.

What agents report about their work, the summaries their hooks send (tool names, file paths, the start of shell commands; see [what the recorder sends](../integrations/claude-code/README.md#what-the-recorder-sends)) and session labels, is shown only to `editor` and `owner` access and to you at the server's machine. Viewers and commenters see that an agent is there and its coarse status, not what it is doing. Editors, including editor agents, do see it: turn summaries off with `OPENBOARD_HOOK_DETAIL=off` where an agent runs if that is too much for them.

## Limits per grant

A grant may have at most 50 browser sessions (the oldest end first), 32 open sync connections and 20 unused connection tickets. After 20 failed sign-in attempts in 10 minutes from one client, further attempts get `429 rate_limited` for a while.

## What is not protected

- **Display names are cosmetic.** A signed-in caller chooses the name shown with its edits; the actor id and kind come from the grant. Check the actor id (`openboard access list`) when it matters.
- **Editors' browsers write to the document directly.** People with `editor` or `owner` access sync changes to the board like local users; the review policy applies to agents, not to people. What such a client writes is checked for its schema and corrected for authorship: anything it creates is attributed to its own actor, a changed author or creator on existing nodes, edges and comments is put back, and changes to questions and proposals are reverted (those go through the API, where the people-only checks apply). Every change, comments included, lands in the history under the connection's actor. Within that, an editor can change any content on the board, so give `editor` only to people you would let edit the board files in the repository.
- **No end-to-end encryption.** The server sees everything, and transport security is the job of your proxy or tunnel.
- **No audit log beyond the board's history.** Board changes are attributed and kept in the history; sign-ins, reads and access changes are not logged.
- **Tokens are bearer credentials.** Anyone holding a token or an invite link has its access until it expires or you revoke it. The server stores only their hashes, in `.openboard/.local/access.json` (readable by your user only), and never prints them in logs or errors.

Security issues: see [SECURITY.md](../SECURITY.md).
