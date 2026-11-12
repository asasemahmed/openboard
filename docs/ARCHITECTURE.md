# Architecture

This document describes how OpenBoard is put together and the contracts between its parts. If code and this document disagree, fix one of them in the same change.

## The idea in one paragraph

A board is a typed graph that lives in a shared document. Humans edit it in the browser. Agents edit it through a small API (exposed as MCP tools) that reads in token-budgeted slices and writes whole, validated intents. A local server owns the document, keeps everyone in sync, lays nodes out, and saves the board as a readable file in the repository.

```
  Agents (any MCP client)                              Humans (browser)
        |  MCP: stdio or HTTP                                |  WebSocket (CRDT sync)
        v                                                    v
  +--------------------------------------------------------------------+
  |                          openboard server                          |
  |   agent API  ->  validation + layout  ->  board document (Yjs)     |
  +--------------------------------------------------------------------+
                                   |
                     .openboard/<board>.board.json   (in your repo)
```

## Packages

| Package           | Name                | Depends on       | Role                                                                                                                |
| ----------------- | ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/core`   | `@openboard/core`   | —                | Schema, operations, the board document, queries, text rendering, serialization, diffing. No network or disk access. |
| `packages/server` | `@openboard/server` | core             | The local server: sync, persistence, layout, change feed, the agent API over HTTP.                                  |
| `packages/sdk`    | `@openboard/sdk`    | core             | `BoardApi` over HTTP, for code that talks to a running server.                                                      |
| `packages/mcp`    | `@openboard/mcp`    | core, sdk        | MCP tools built on any `BoardApi`.                                                                                  |
| `packages/app`    | `@openboard/app`    | core             | The web canvas. Built to static files that the server serves.                                                       |
| `packages/cli`    | `openboard`         | all of the above | The `openboard` command.                                                                                            |

Dependencies point one way: `core` knows nothing about the others, and nothing imports from `app` or `cli`.

## Data model

Defined in [`packages/core/src/schema.ts`](../packages/core/src/schema.ts).

- A **node** has a `type` (`note`, `task`, `decision`, `question`, `risk`, `doc`, `code`, `agent`, `run`, `frame`, or a custom `x:name`), a `title`, and optionally a markdown `body`, a `status`, `tags`, free-form `props`, `links` to code or URLs, and a `parent` frame.
- An **edge** has a `type` (`relates_to`, `depends_on`, `blocks`, `implements`, `evidence_for`, `flows_to`, or custom), a `source`, a `target`, and an optional `label`.
- A node's **view** (`x`, `y`, `w`, `h`, `pinned`, `color`, `collapsed`) is presentation. It is kept apart from meaning on purpose: agents do not place nodes, the layout engine does, and a node a human dragged is `pinned` and left alone.
- View coordinates are relative to the parent frame's top-left corner (or to the canvas origin for a node with no parent), so moving a frame moves its children without rewriting them. Default node sizes come from `defaultNodeSize` in `core`, which the layout engine and the canvas share so a server-side layout does not overlap in the browser.
- Every node and edge records who created and last changed it. `updatedAt` moves only on semantic changes, never on a move or resize.

### Semantic rules

These hold at all times and are enforced when operations are validated:

- `parent` must be an existing `frame` node, and the parent chain must not form a cycle.
- An edge's `source` and `target` must exist and must differ.
- There is at most one edge per (`type`, `source`, `target`).
- Changing a node's `parent` without also giving it a position clears its position, so the layout engine places it in the new frame.
- Removing a node removes the edges that touch it. Removing a frame moves its children to the frame's own parent, unless the operation asks to cascade.

## Operations

Defined in [`packages/core/src/ops.ts`](../packages/core/src/ops.ts).

Meaning changes only through operations: `add_node`, `update_node`, `remove_node`, `move_node`, `add_edge`, `update_edge`, `remove_edge`. A batch is validated as a whole against the current board and applied in one transaction. If any operation is invalid, nothing is applied and every problem is reported with the index of the operation that caused it.

Inside a batch, `add_node` can declare a `ref`, and later operations can use `"$ref"` wherever a node id is expected. This lets an agent create a connected structure in one call without knowing ids in advance.

## The board document

The live board is a Yjs document, so that concurrent edits from browsers and from the server merge without conflicts. Its layout is a contract between `core`, `server`, and `app`:

| Top-level key | Yjs type          | Contents                                                               |
| ------------- | ----------------- | ---------------------------------------------------------------------- |
| `meta`        | `Y.Map`           | `schemaVersion`, `id`, `name`, `description`, `createdAt`, `updatedAt` |
| `actors`      | `Y.Map<Actor>`    | Plain actor objects by id                                              |
| `nodes`       | `Y.Map<Y.Map>`    | One `Y.Map` per node, keyed by node id                                 |
| `edges`       | `Y.Map<Y.Map>`    | One `Y.Map` per edge, keyed by edge id                                 |
| `proposals`   | `Y.Map<Proposal>` | Plain proposal objects by id (working state, not saved in the file)    |
| `asks`        | `Y.Map<Ask>`      | Plain question objects by id (working state, not saved in the file)    |
| `comments`    | `Y.Map<Comment>`  | Plain comment objects by id (saved in the file under `comments`)       |
| `claims`      | `Y.Map<Claim>`    | Plain claim objects by node id (working state, not saved in the file)  |

Inside a node or edge map, each schema field is one key holding a plain JSON value. That includes `body` (a string), `tags`, `props`, `links`, and `view` (replaced as a whole). Conflict resolution is therefore last-writer-wins per field, which is the right grain for a board: two people editing different fields of one node both win, and two people editing the same field get one consistent result.

Code never touches these maps directly. `BoardDoc` in `core` wraps the Yjs document and is the only thing that reads or writes it; it also turns raw Yjs events into a normalized list of changes. Its `DocEvent` names the proposals, questions, comments and claims a transaction changed, and carries the exact before and after state of every node, edge, comment, actor and the metadata it changed (`states`), which is what history, undo and replay are built on. Entries of the plain maps that fail their schema are skipped and listed by `issues()`.

### Lineage

Every live document has a random **lineage** id, made when the document is created or rebuilt from the board file (for example after `.openboard/.local/` was deleted). It is stored next to the `.ydoc` snapshot, never in the board file, and is shown as `lineage` in the board listing and as the `x-openboard-lineage` header of `GET /api/boards/:id`. A browser must pass it when it syncs (`/sync/:id?lineage=...`); a socket without it, or with another one, is closed with code `4409` (`CLOSE_STALE_DOCUMENT`) before anything it sent is applied. This stops a tab left open from an earlier server, or from an earlier life of the board, from merging its stale document into a different board with the same id. On that close code a client should drop its document, fetch the board again and reconnect with the new lineage.

A comment whose node was removed keeps its `nodeId`, so restoring the node re-attaches it; readers treat such a thread as detached.

### Transaction origins

Every write is a Yjs transaction tagged with an origin of this shape, exported from `core`:

```ts
interface TxOrigin {
  actorId: string;
  source: 'ops' | 'ui' | 'layout' | 'file' | 'undo' | 'sync' | 'code';
}
```

The origin is how the server attributes a change to an actor in the change feed, and how undo is scoped to one actor.

## People in control

Defined in [`packages/core/src/collab.ts`](../packages/core/src/collab.ts).

**Review policy.** `.openboard/config.json` (committed) sets a mode per agent and a default: `auto`, `review_destructive` (the default), `review_all` or `locked`. A frame can override it for its contents through `props["openboard.policy"]` (`auto`, `review`, `locked`). People are never restricted. `classifyOps` in core is the whole rule set, as a pure function. On `apply` by an agent the server validates the batch, then classifies it: anything `denied` makes the batch `invalid` with `forbidden` errors; anything `review` turns the whole batch into one **proposal**; otherwise it applies.

**Proposals.** A proposal holds every operation of the batch, with refs already resolved to the ids they will get, so the canvas can draw the preview as ghosts and accepting lands on the same ids. New nodes carry views from the layout engine, and `preview.views` gives the new views of existing nodes the layout would change (frames growing to hold the ghosts, siblings they push aside). A person accepts or rejects all or some items; dependencies are respected (accepting an edge accepts the node it needs, rejecting a node rejects the edge). Accepted items are applied as one batch attributed to the proposal's author. Each item remembers a fingerprint of what it changes; when that changes or vanishes, the item becomes a `conflict` (immediately while pending, re-checked on accept) and the preview is recomputed, so ghosts never show something that would fail. The most recent 50 decided proposals are kept.

**History and undo.** Every change to nodes, edges and comments is a batch: an agent's apply together with the layout pass that follows it, an accepted proposal, a layout run, a file reload, an undo, or a person's browser edits (consecutive edits by one person less than 5 seconds apart are one batch). For each batch the server keeps the exact state of every item before and after. Undo restores an item only if it is still exactly as the batch left it, and reports the rest as conflicts; it never overwrites later work or leaves an edge without its nodes. An undo is itself a batch, so undoing it redoes. `apply` returns the `batchId` it became. Undoing by actor (`last`, `all`) considers only batches that changed nodes or edges; a comment-only batch is undone by its id.

Undo follows the review policy. People may undo anything. An agent may undo only its own batches, and not at all in `locked` mode; it restores an item only where that restoring change would be `free` for it under the current policy, and leaves the rest as conflicts (`needs review: ...`, `not allowed: ...`). The reviewed items of a batch that came from an accepted proposal are left to people (`was applied through a reviewed proposal; ask a person to undo it`).

Everyone who proposes, asks, answers, decides, comments or undoes is added to the board's actor registry, so their name is shown instead of their id.

**Comments, inbox and questions.** Comments live in the document (browsers write them directly) and in the board file. Mentions, replies, answers to questions, decisions on proposals and undone batches become inbox items for the actor concerned, never for the one who acted. Agents ask people questions through `ask`, and can long-poll `askResult` for the answer; an answer that `askResult` returned to its author is not delivered again by the inbox (a read with `since` still shows it). `asks` lists the open questions.

**"People only": a guard in local mode, a control in shared mode.** Deciding proposals, answering questions, changing settings and managing access require an actor of kind `human`. In local mode the kind is whatever the caller declares (the `x-openboard-actor-kind` header) and the server has no authentication, so the check stops an agent from approving its own work by mistake, not a program that lies about who it is. In [shared mode](#shared-mode) a remote caller's kind comes from its access grant, so an agent grant can never decide a proposal or answer a question, whatever it sends.

## Work in progress

Defined in [`packages/core/src/live.ts`](../packages/core/src/live.ts). All of it is memory only on the server (claims excepted, see below), and none of it reaches the board file, the change feed or the history.

**Agent presence.** Agents are not sync peers, so the server publishes their presence into each board's awareness: one entry per agent and session, `{ actor, agent: { status, detail?, focus?, session, parent?, at } }`. Every API call by an agent updates it: reads are `reading` with `focus` on the nodes returned (at most 20), writes are `writing` with `focus` on what they touched, a long-poll on a question is `waiting`. After 20 seconds without activity an agent is `idle`, or `waiting` when it has a pending proposal or an open question there; after 10 minutes it disappears. A call names its session with the `x-openboard-session` header (the SDK's `session` option); calls without one use the session `default`. A caller that sends no actor headers at all gets no presence and is not remembered; it reaches the actor registry only by changing something.

**Activity sessions.** Agent tooling (editor or CLI hooks) reports what it does with `POST /api/activity` (`ActivityEvent`): sessions starting and ending, prompts, tools starting and ending, subagents. The server keeps the most recent 200 sessions, drops ended ones after 30 minutes, and shows a session as `working` (with `detail`, for example `Bash: pnpm test`) on every board its agent touched since the server started and on every board open in a browser. `GET /api/sessions` lists them. Browsers receive the list through the same awareness: one entry per open board, `{ actor: SYSTEM_ACTOR, live: { sessions, at } }`, holding sessions that have not ended (at most 50, each with its last 5 steps). Awareness was chosen over a separate event stream because each open board already has an awareness connection.

Activity text is untrusted and may be sensitive: it can quote file paths and command lines. The server strips control characters, cuts summaries to 200 and labels to 80 characters, and keeps it in memory only; it is never written to disk.

**Claims.** An agent can claim nodes it is working on (`POST /api/boards/:id/claims`), for 15 minutes by default and 120 at most. A claim is a soft lock kept in the document's `claims` map, so browsers see it; it is not a board edit, needs no review, and is not saved in the board file or the history. While a claim is in force, another agent's `apply` that changes, removes or re-parents the node (or removes the frame it sits in) is refused with the operation error `claimed`; moving it is still allowed, and people are never blocked. Claiming is all or nothing unless `partial`; releasing goes node by node, and people may release any claim. Any later call by the holder on that board renews its claims once half their length has passed. Expired claims are ignored at once and swept away within seconds; removing a node removes its claim. Reads mark claimed nodes (`claimed by <name> until <time>`).

**Replay.** The history also keeps every transaction that changed the board JSON, with exact before and after states (the last 5000). `snapshotAt(cursor)` (`GET /api/boards/:id/at/:cursor`) rebuilds the board as it was right after that cursor by reverting later transactions, newest first. `HistoryResult.earliest` is the oldest cursor it can reach; an older one fails with `not_found`. Snapshots are exact for every cursor because every change to the board JSON moves the cursor, including changes that have no entry in the change feed (comments, the actor registry, board metadata): the feed records a hidden mark for those.

## Code and git

Defined in [`packages/core/src/code.ts`](../packages/core/src/code.ts).

**Code links.** A node's `file` and `symbol` links point into the project: a path relative to the root (`symbol` is `path#name`). The server fills `hash` when a link has none: `sha256:` and the first 32 hex digits of the SHA-256 of the linked text with line endings normalised to `\n` — the whole file, or lines `line..endLine` (1-based, inclusive). It watches every linked file of every open board (chokidar, debounced, following editors that save by renaming, with a stat poll every 2 seconds as a backstop; at most 2000 watched files, files over 5 MB are not read). When the linked text changes, a range whose original text now sits exactly once elsewhere in the file just moves (`line`/`endLine` follow, at most 200 lines); otherwise the link gets `stale: true`, as it does when the file is gone. `stale` clears when the text matches again. All links are checked when a board is opened. The original text of ranges is kept in memory only (at most 4 MB), so code that moved while the server was not running turns stale instead of being followed.

These writes are made as the system actor with the transaction source `code`. They keep the node's bookkeeping fields, appear in the change feed (`node_updated`, field `links`), never need review and are not history batches; undo and proposals ignore them when they compare a node with what they expect. Paths that leave the project after normalisation, absolute paths outside it, and symlinks that resolve outside are never read; `links` reports them as `outside`.

`links` lists every link with its state (`ok`, `stale`, `missing`, `outside`, `unchecked`) and what changed; `refreshLinks` re-hashes the named nodes' links against the code as it is now and clears `stale`, as a normal batch with the reason "Refresh code links" (so for an agent it follows the review policy). Reads mark stale links at every detail, and the outline counts them.

**Git.** `revisions` lists the commits that touched the board file (`tracked: false`, not an error, outside a repository, when git is missing, or for a file never committed), `boardAtRevision` parses the file as committed, and `diffRevisions` compares two revisions or a revision with the live board. Git runs with `execFile` (no shell), a timeout and the project root as its working directory; a revision must match `RevisionSchema` (no leading `-`, no whitespace, `:` or `..`) and is resolved to a commit id before anything else uses it.

**Import and export.** `importInto` reads Mermaid or JSON Canvas through the importers in `core/src/interop` and applies the result as one normal batch by the caller (policy, layout, history with the reason "Import from <format>"), optionally inside a frame; `GET /api/boards/:id/export?format=` returns any exporter's output as a download, and `format=svg&diffFrom=<rev>` draws the changes since that revision.

## Reading a board

Agents never receive a whole board by default. The read path, in the order an agent normally uses it:

1. **Outline** — frames, counts by type and status. The shape of the board for a few hundred tokens.
2. **Read** — a slice chosen by ids, frame, the human's current selection, type, status, tags, text, and optionally neighbours, at a chosen level of detail.
3. **Changes** — what happened since a cursor, by whom. By default it leaves out the caller's own changes and pure moves.

Every read takes `maxTokens`, returns `text` (a compact rendering for a model) together with structured data, reports its estimated `tokens`, and sets `truncated` when it had to leave something out. Token estimates use one shared function, `estimateTokens`, so budgets mean the same thing everywhere.

The **cursor** is a per-board counter that grows with every change. An agent keeps the cursor from its last read and passes it to `changes`.

## The agent API

Defined in [`packages/core/src/api.ts`](../packages/core/src/api.ts) as the `BoardApi` interface. It is the single contract for reaching a board:

- `server` implements it in-process.
- `sdk` implements it over HTTP.
- `mcp` turns any `BoardApi` into MCP tools.

A `BoardApi` instance is a session bound to one actor; everything done through it is attributed to that actor.

## The server

One server process serves one project root.

### HTTP surface

| Method and path                                       | Purpose                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /api/health`                                     | `{ ok, version, pid, root }` (shared mode: see below)                   |
| `GET /api/info`                                       | `{ version, root, projectName, url, ...ServerOptions.info }`            |
| `GET /api/whoami`                                     | `BoardApi.whoami`: `{ actor, role, shared, via, grantId?, expiresAt? }` |
| `GET /api/access` · `POST /api/access`                | `BoardApi.listAccess` · `grantAccess` (201; people with `owner`)        |
| `DELETE /api/access/:grant`                           | `BoardApi.revokeAccess` (people with `owner`)                           |
| `POST /api/auth/session` · `POST /api/auth/logout`    | Trade an invite token for a session cookie · end it (shared mode)       |
| `POST /api/auth/ticket`                               | A single-use ticket for one sync socket (201; shared mode)              |
| `GET /api/boards` · `POST /api/boards`                | List and create boards                                                  |
| `GET /api/boards/:id`                                 | Full board JSON                                                         |
| `POST /api/boards/:id/outline`                        | `BoardApi.outline`                                                      |
| `POST /api/boards/:id/read`                           | `BoardApi.read`                                                         |
| `POST /api/boards/:id/changes`                        | `BoardApi.changes`                                                      |
| `POST /api/boards/:id/apply`                          | `BoardApi.apply`                                                        |
| `GET /api/boards/:id/selection`                       | `BoardApi.selection`                                                    |
| `POST /api/boards/:id/layout`                         | `BoardApi.layout`                                                       |
| `GET /api/config` · `PUT /api/config`                 | `BoardApi.getConfig` · `setConfig` (people only)                        |
| `GET /api/boards/:id/proposals?status=&maxTokens=`    | `BoardApi.proposals` (`status` is `pending` or `all`)                   |
| `POST /api/boards/:id/proposals/:pid/decide`          | `BoardApi.decideProposal` (body: `Decision`; people only)               |
| `POST /api/boards/:id/proposals/:pid/withdraw`        | `BoardApi.withdrawProposal` (author only)                               |
| `POST /api/boards/:id/history`                        | `BoardApi.history` (body: `HistoryOptions`)                             |
| `POST /api/boards/:id/undo`                           | `BoardApi.undo` (body: `UndoRequest`)                                   |
| `POST /api/boards/:id/comments`                       | `BoardApi.comment` (body: `CommentInput`; 201 with the `Comment`)       |
| `POST /api/boards/:id/threads/:thread/resolve`        | `BoardApi.resolveThread` (body: `{ resolved }`, default true)           |
| `POST /api/boards/:id/inbox`                          | `BoardApi.inbox` (body: `InboxOptions`)                                 |
| `POST /api/boards/:id/asks`                           | `BoardApi.ask` (body: `AskInput`; 201 with the `Ask`)                   |
| `GET /api/boards/:id/asks?status=&maxTokens=`         | `BoardApi.asks` (`status` is `open`, the default, or `all`)             |
| `GET /api/boards/:id/asks/:aid?waitMs=`               | `BoardApi.askResult`; a long-poll of at most `MAX_ASK_WAIT_MS`          |
| `POST /api/boards/:id/asks/:aid/answer`               | `BoardApi.answerAsk` (body: `AnswerInput`; people only)                 |
| `POST /api/boards/:id/asks/:aid/cancel`               | `BoardApi.cancelAsk` (the author or a person)                           |
| `POST /api/activity`                                  | `BoardApi.reportActivity` (body: `ActivityEvent`)                       |
| `GET /api/sessions?includeEnded=&maxTokens=`          | `BoardApi.sessions`                                                     |
| `POST /api/boards/:id/claims`                         | `BoardApi.claim` (body: `ClaimRequest`)                                 |
| `GET /api/boards/:id/at/:cursor`                      | `BoardApi.snapshotAt`: the `Board` right after that cursor              |
| `POST /api/boards/:id/links`                          | `BoardApi.links` (body: `LinksOptions`)                                 |
| `POST /api/boards/:id/links/refresh`                  | `BoardApi.refreshLinks` (body: `RefreshLinksRequest`)                   |
| `GET /api/boards/:id/revisions?limit=`                | `BoardApi.revisions`                                                    |
| `GET /api/boards/:id/revisions/:rev`                  | `BoardApi.boardAtRevision`                                              |
| `POST /api/boards/:id/diff`                           | `BoardApi.diffRevisions` (body: `DiffRequest`)                          |
| `POST /api/boards/:id/import`                         | `BoardApi.importInto` (body: `ImportRequest`)                           |
| `GET /api/boards/:id/export?format=&theme=&diffFrom=` | The exporter's output as a download (its own content type)              |
| `GET /sync/:id?lineage=` (WebSocket)                  | Document sync and presence, using the standard y-websocket protocol     |
| `ALL /mcp`                                            | MCP over Streamable HTTP, mounted with `OpenBoardServer.mount`          |
| `GET /*`                                              | The web app                                                             |

Request and response bodies are the JSON forms of the `BoardApi` types. Errors are `{ "error": { "code", "message", "details" } }` with the HTTP status from `OpenBoardError.status`.

The long-poll is not cut by a server-side timeout (Node's request timeout only covers receiving the request), and a client that disconnects ends the wait at once. Missing proposals, batches and questions are `not_found` (404); acting on something already decided, answered or undone is `conflict` (409); a people-only or author-only call by someone else is `forbidden` (403).

In local mode the caller's actor is taken from the headers `x-openboard-actor-id`, `x-openboard-actor-name`, and `x-openboard-actor-kind`, and its agent session from `x-openboard-session`. Over the WebSocket the actor arrives as query parameters `actorId`, `actorName`, `actorKind`, next to the required `lineage`. In shared mode these are read only for the owner at this machine; a caller with credentials is the grant's actor (see below).

Every route is registered with the permission it needs (the `BoardApi` method's entry in `API_ACTIONS`, see [roles](#roles)), and the caller's role is checked before the handler runs; `LocalBoardApi` checks the same table again, so in-process sessions given a role are held to it too. No `GET` route changes board content.

`OpenBoardServer.mount(path, handler)` routes a path (such as `/mcp`) to `handler(request, caller)`; request bodies are capped at `MAX_BODY_BYTES` (2 MB, `413` beyond) as on the API. `caller` is `{ actor, role, via, shared, anonymous, grantId? }` as the server established it; in shared mode a request without valid credentials never reaches the handler, and for a remote caller the server removes `Authorization`, `Cookie` and the actor id and kind headers from the request first. A handler acts for the caller with `server.api(caller.actor, { session, role: caller.role, via: caller.via, grantId: caller.grantId })`, never with identity read from headers; such a session fails with `unauthorized` once the grant is revoked or expires.

### Presence and selection

Presence travels over the y-websocket awareness channel. Each browser publishes this state:

```ts
interface Presence {
  actor: Actor;
  cursor?: { x: number; y: number }; // canvas coordinates
  selection?: { nodeIds: string[]; edgeIds: string[]; at: string };
}
```

The server reads awareness to answer `BoardApi.selection` with the most recent non-empty human selection.

### Files on disk

```
<project root>/
  .openboard/
    <board id>.board.json     the board; deterministic, meant for git
    config.json               project settings (review policy); deterministic, meant for git
    .local/                   runtime state; ignored by git
      server.json             { pid, port, url, root, version, startedAt, shared?, publicUrl? } of the running server;
                              the CLI and `openboard hook` only contact a `url` of this machine (plain http to a
                              loopback name or a local interface address), since a repository can ship this file
      access.json             access grants with the SHA-256 of their secrets (shared mode; mode 0600)
      sessions.json           browser sessions, by the SHA-256 of their ids (shared mode; mode 0600)
      <board id>.ydoc         document state with history (and pending proposals and questions)
      <board id>.changes.jsonl  the change feed
      <board id>.history.jsonl  batches (last 2000) and transactions (last 5000) with before/after
                                states, for history, undo and replay; starts with its lineage
      <board id>.inbox.jsonl    inbox items and each actor's read position
      <board id>.lineage        the lineage of the document in <board id>.ydoc
```

The JSON file is the source of truth. It is written with sorted keys and one stable layout, so a small change to the board is a small diff. When the file changes on disk (a checkout, a merge, a manual edit), the server reconciles the live document to match it. `config.json` is watched the same way; while it does not parse, the last good settings stay in effect.

The change feed gives each change the `reason` and `batchId` of the batch it belongs to. A transaction that only changed comments still moves the cursor (through a mark line in the feed file) but adds no entry.

The project root is the nearest ancestor directory that contains `.openboard/`, then the git root, then the current directory.

### Local security

The server binds to `127.0.0.1` by default. It rejects requests whose `Host` is not a loopback name, and rejects browser requests whose `Origin` is not its own, which closes the DNS-rebinding and cross-site paths to a local server. One exception, for working on the web app: on `/api/` and `/sync/` the origin of its dev server, `http://localhost:5173` and `http://127.0.0.1:5173` (`ALLOW_DEV_ORIGINS`), is accepted too, so a page served at that origin by any program on the machine can use the API and the socket as a local caller. Board content is treated as untrusted input throughout: reads label who wrote what, so an agent can tell a teammate's note from an instruction.

Presence from clients is checked in both modes: an awareness entry may only use a client id its connection owns (or a fresh one, at most 4 per connection; the same actor reconnecting may take its old entry over), at most 16 KB of JSON, and its `actor` is rewritten to the connection's actor id and kind (the name may be the client's, and so may the color when it is `#hex`, a name or a number: `ColorSchema`, which stored actors and views follow too, so no color can carry `url(...)` into CSS). `agent` and `live`, which only the server publishes, are removed, so no client can pose as another person, an agent or the `system` actor.

### Shared mode

Defined in [`packages/core/src/access.ts`](../packages/core/src/access.ts) (roles, grants) and `packages/server/src/{auth,access}.ts`.

Shared mode lets people on other machines, and agents running elsewhere, work on the boards. It is on with `ServerOptions.shared: true`, and implied by a non-loopback `host`; there is no unauthenticated remote mode (`shared: false` with a non-loopback host is refused, and so is a wildcard host such as `0.0.0.0` without `publicUrl`). `ServerOptions.publicUrl` is the origin people use (for example `https://board.example.com` behind a tunnel or a reverse proxy with TLS; no path). Its host and origin are accepted besides loopback by the `Host`/`Origin` check, it is the base of invite links, and with https the session cookie is `Secure`. Without it, the server's own URL is used.

**Who gets in.** Every request needs credentials except static app files, `GET /api/health` (which then answers `{ ok, version, shared: true }`, plus `pid` and `root` for the owner at this machine), `POST /api/auth/session` and `POST /api/auth/logout`. Without credentials, `401 unauthorized`. A request that presents credentials is judged by them alone (a bad token is never rescued by local trust); without any, the **local-trust rule** (`isLocalOwnerRequest`) applies: the request is the owner at this machine, with the actor from headers as in local mode, only when the socket's peer address is loopback, AND `Host` is a loopback name on the server's port, AND there is no header a relay adds (`isForwardingHeader`: `Forwarded`, `Via`, `X-Real-IP`, `Cdn-Loop`, the client-IP headers of common CDNs, and any name starting with `X-Forwarded-`, `X-Original-`, `CF-`, `Fly-`, `X-Envoy-` or `Tailscale-`). A tunnel or reverse proxy on the same machine connects from loopback, so the first condition alone would hand everyone the owner's role; such relays keep the public `Host` or add forwarding headers. A relay that rewrites `Host` to localhost and strips every forwarding header cannot be told apart from a local program: do not run one in front of a shared server. This keeps the local CLI, the local MCP server and a browser on the server's machine working unchanged.

**Grants and tokens.** An access grant (`AccessGrant`: `id, label, role, kind, actorId, createdAt, createdBy, expiresAt?, revokedAt?, lastUsedAt?`) is made by a person with `owner` access (`grantAccess({ label, role, kind, expiresInHours? })`). Its token is `ob_<grant id>_<secret>`, the secret 32 random bytes in base64url; only its SHA-256 is stored, in `access.json`, and the token is returned once, with `inviteUrl` (`<publicUrl>/join#<token>`) for people. Checking a token costs one constant-time hash comparison whether the grant id or the secret is wrong, and every failure gets the same message. `actorId` is made from the label and the grant id (`ada-k3x9a0`); it is what the review policy's per-agent modes name. Revoking takes effect at once: the grant's requests fail with `401`, its sessions and tickets end, its sockets close with `4401`, and on every open board its claims are released and its open questions cancelled (nobody can collect the answer). Its pending proposals stay for people to accept or reject. An expired grant fails the same way; its open sockets close within 30 seconds.

**Identity.** An authenticated caller's actor is `{ id: grant.actorId, kind: grant.kind, name }`. The name is the one a ticket was issued with, else the `x-openboard-actor-name` header (on a socket upgrade too; `actorName` is not read for them), else the name given at sign-in, else the grant's label; the id and kind headers are ignored. So the people-only checks are real in shared mode, and an agent grant stays under the review policy exactly as in local mode: its role caps what it may attempt, the policy decides what needs review.

**Presenting credentials.**

- Programs (the SDK, remote MCP clients): `Authorization: Bearer <token>`.
- Browsers: an invite link `<publicUrl>/join#<token>` carries the token in the fragment, which never reaches the server, proxies, logs or `Referer`. The app posts it to `POST /api/auth/session` with `{ token, name? }` (the request must carry the app's `Origin`); the answer is the `WhoAmI` and the cookie `__Host-openboard_session` (with https; `openboard_session` with http) set with `Path=/; HttpOnly; SameSite=Strict; Max-Age` (30 days, or until the grant expires) and `Secure` with https. The value is a fresh random session id, never one the client brought; any previous session of the browser ends. The server keeps sessions in memory and their hashes in `sessions.json`, so a restart keeps people signed in; a session ends with its grant, on logout, after 30 days without use, or when the grant opens more than 50. `POST /api/auth/logout` ends it and clears the cookie. A cookie-authenticated request other than `GET`/`HEAD` must carry `Origin` (and the `Origin` check requires it to be the app's), so another site can neither ride the cookie (it is `SameSite=Strict` as well) nor sign a visitor in to a grant of its choosing.
- Sync sockets: browsers send the cookie on the upgrade (with their `Origin`); programs send `Authorization: Bearer`, or, when their WebSocket client cannot set headers, `?ticket=` with a ticket from `POST /api/auth/ticket` (`{ ticket, expiresAt }`, single use, valid 60 seconds, at most 20 outstanding per grant). A token in a socket URL (`?token=`) is refused with 400.

Failed credentials (a wrong token, ticket or cookie) are counted per client, the peer address or, behind a relay on this machine, the last `X-Forwarded-For` entry: after 20 in 10 minutes, attempts from that client get `429 rate_limited` with `Retry-After`. Log lines and error messages never carry a token, ticket or cookie (`scrubSecrets`). Responses carry `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`.

**Read-only sync.** A connection whose role cannot edit boards (`viewer`, `commenter`), or whose actor is an agent (agents change boards through the API, where the policy applies), is read-only: the server answers its sync step 1 but drops its step 2 and update messages unapplied, and answers the first dropped update with one y-protocols auth message, "permission denied", whose reason starts with `read-only:` (`WebsocketProvider` logs it). Presence still works. A commenter therefore comments through `POST /api/boards/:id/comments`, not the document. The owner at this machine and people with `editor` or `owner` access write through sync as in local mode. One grant may hold at most 32 open sockets (`429` on the upgrade beyond that).

**Close codes.** `4401` (`CLOSE_ACCESS_REVOKED`): the connection's credentials no longer hold (revoked, expired, signed out); sign in again rather than reconnecting. Upgrades without valid credentials are refused before the socket opens, with HTTP `401`, `403`, `429` or `400`.

**What owners alone see.** `GET /api/info` gives others only `{ version, projectName, url, shared }` (`url` is the public URL): no local paths, user name or launch commands.

**Agent activity detail.** What agents report about their work (session labels, `current` and `recent` steps with their summaries, and the `detail` and `focus` of agent presence) may quote file paths and commands. Only callers whose role can edit boards (`editor`, `owner`) and the owner at this machine see it (`seesActivityDetail` in `live.ts`). For viewers and commenters, `GET /api/sessions` returns each session without `label` and `current`, with `recent: []`; and every awareness message to their sync connections is built from redacted copies of the server's entries (`redactPresenceState`), so they see that an agent is there and its coarse status only. All awareness messages a connection receives (the first snapshot, updates, answers to a query) go through one function that applies this.

### Roles

| Action (`AccessAction`)                                       | owner | editor | commenter | viewer |
| ------------------------------------------------------------- | :---: | :----: | :-------: | :----: |
| `board.read`, `presence`, `config.read`                       |  yes  |  yes   |    yes    |  yes   |
| `comment`, `ask.create`, `ask.answer`                         |  yes  |  yes   |    yes    |   no   |
| `board.create`, `board.edit`, `board.undo`, `proposal.decide` |  yes  |  yes   |    no     |   no   |
| `config.write`, `access.manage`                               |  yes  |   no   |    no     |   no   |

`can(role, action)` is the whole table; `API_ACTIONS` maps every `BoardApi` method to one action (`null` for `whoami`). Agent grants may be `editor`, `commenter` or `viewer`. A missing permission is `403 forbidden` with a message that names it (`your access (viewer) does not include "board.edit" ...`); missing or invalid credentials are `401 unauthorized`. In local mode every caller is the owner.

## Conventions

- TypeScript, ES modules, Node 22 or newer. Relative imports carry the `.js` extension.
- Libraries build with `tsc -b` into `dist/`. The app builds with Vite.
- Validation at every boundary uses the Zod schemas in `core`; types are inferred from schemas, not written twice.
- Errors that cross a package boundary are `OpenBoardError`s with a stable `code`.
- Tests sit next to the code as `*.test.ts` and run with `pnpm test`.
- `pnpm lint` (Biome) and `pnpm typecheck` must pass.
