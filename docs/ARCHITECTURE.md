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
  source: 'ops' | 'ui' | 'layout' | 'file' | 'undo' | 'sync';
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

**"People only" is a guard, not a boundary.** Deciding proposals, answering questions and changing settings require an actor of kind `human`. The kind is whatever the caller declares (the `x-openboard-actor-kind` header); the server has no authentication on loopback. The check stops an agent from approving its own work by mistake, not a program that lies about who it is.

## Work in progress

Defined in [`packages/core/src/live.ts`](../packages/core/src/live.ts). All of it is memory only on the server (claims excepted, see below), and none of it reaches the board file, the change feed or the history.

**Agent presence.** Agents are not sync peers, so the server publishes their presence into each board's awareness: one entry per agent and session, `{ actor, agent: { status, detail?, focus?, session, parent?, at } }`. Every API call by an agent updates it: reads are `reading` with `focus` on the nodes returned (at most 20), writes are `writing` with `focus` on what they touched, a long-poll on a question is `waiting`. After 20 seconds without activity an agent is `idle`, or `waiting` when it has a pending proposal or an open question there; after 10 minutes it disappears. A call names its session with the `x-openboard-session` header (the SDK's `session` option); calls without one use the session `default`.

**Activity sessions.** Agent tooling (editor or CLI hooks) reports what it does with `POST /api/activity` (`ActivityEvent`): sessions starting and ending, prompts, tools starting and ending, subagents. The server keeps the most recent 200 sessions, drops ended ones after 30 minutes, and shows a session as `working` (with `detail`, for example `Bash: pnpm test`) on every board its agent touched since the server started and on every board open in a browser. `GET /api/sessions` lists them. Browsers receive the list through the same awareness: one entry per open board, `{ actor: SYSTEM_ACTOR, live: { sessions, at } }`, holding sessions that have not ended (at most 50, each with its last 5 steps). Awareness was chosen over a separate event stream because each open board already has an awareness connection.

Activity text is untrusted and may be sensitive: it can quote file paths and command lines. The server strips control characters, cuts summaries to 200 and labels to 80 characters, and keeps it in memory only; it is never written to disk.

**Claims.** An agent can claim nodes it is working on (`POST /api/boards/:id/claims`), for 15 minutes by default and 120 at most. A claim is a soft lock kept in the document's `claims` map, so browsers see it; it is not a board edit, needs no review, and is not saved in the board file or the history. While a claim is in force, another agent's `apply` that changes, removes or re-parents the node (or removes the frame it sits in) is refused with the operation error `claimed`; moving it is still allowed, and people are never blocked. Claiming is all or nothing unless `partial`; releasing goes node by node, and people may release any claim. Any later call by the holder on that board renews its claims once half their length has passed. Expired claims are ignored at once and swept away within seconds; removing a node removes its claim. Reads mark claimed nodes (`claimed by <name> until <time>`).

**Replay.** The history also keeps every transaction that changed the board JSON, with exact before and after states (the last 5000). `snapshotAt(cursor)` (`GET /api/boards/:id/at/:cursor`) rebuilds the board as it was right after that cursor by reverting later transactions, newest first. `HistoryResult.earliest` is the oldest cursor it can reach; an older one fails with `not_found`.

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

| Method and path                                    | Purpose                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /api/health`                                  | `{ ok, version, pid, root }`                                        |
| `GET /api/info`                                    | `{ version, root, projectName, url, ...ServerOptions.info }`        |
| `GET /api/boards` · `POST /api/boards`             | List and create boards                                              |
| `GET /api/boards/:id`                              | Full board JSON                                                     |
| `POST /api/boards/:id/outline`                     | `BoardApi.outline`                                                  |
| `POST /api/boards/:id/read`                        | `BoardApi.read`                                                     |
| `POST /api/boards/:id/changes`                     | `BoardApi.changes`                                                  |
| `POST /api/boards/:id/apply`                       | `BoardApi.apply`                                                    |
| `GET /api/boards/:id/selection`                    | `BoardApi.selection`                                                |
| `POST /api/boards/:id/layout`                      | `BoardApi.layout`                                                   |
| `GET /api/config` · `PUT /api/config`              | `BoardApi.getConfig` · `setConfig` (people only)                    |
| `GET /api/boards/:id/proposals?status=&maxTokens=` | `BoardApi.proposals` (`status` is `pending` or `all`)               |
| `POST /api/boards/:id/proposals/:pid/decide`       | `BoardApi.decideProposal` (body: `Decision`; people only)           |
| `POST /api/boards/:id/proposals/:pid/withdraw`     | `BoardApi.withdrawProposal` (author only)                           |
| `POST /api/boards/:id/history`                     | `BoardApi.history` (body: `HistoryOptions`)                         |
| `POST /api/boards/:id/undo`                        | `BoardApi.undo` (body: `UndoRequest`)                               |
| `POST /api/boards/:id/comments`                    | `BoardApi.comment` (body: `CommentInput`; 201 with the `Comment`)   |
| `POST /api/boards/:id/threads/:thread/resolve`     | `BoardApi.resolveThread` (body: `{ resolved }`, default true)       |
| `POST /api/boards/:id/inbox`                       | `BoardApi.inbox` (body: `InboxOptions`)                             |
| `POST /api/boards/:id/asks`                        | `BoardApi.ask` (body: `AskInput`; 201 with the `Ask`)               |
| `GET /api/boards/:id/asks?status=&maxTokens=`      | `BoardApi.asks` (`status` is `open`, the default, or `all`)         |
| `GET /api/boards/:id/asks/:aid?waitMs=`            | `BoardApi.askResult`; a long-poll of at most `MAX_ASK_WAIT_MS`      |
| `POST /api/boards/:id/asks/:aid/answer`            | `BoardApi.answerAsk` (body: `AnswerInput`; people only)             |
| `POST /api/boards/:id/asks/:aid/cancel`            | `BoardApi.cancelAsk` (the author or a person)                       |
| `POST /api/activity`                               | `BoardApi.reportActivity` (body: `ActivityEvent`)                   |
| `GET /api/sessions?includeEnded=&maxTokens=`       | `BoardApi.sessions`                                                 |
| `POST /api/boards/:id/claims`                      | `BoardApi.claim` (body: `ClaimRequest`)                             |
| `GET /api/boards/:id/at/:cursor`                   | `BoardApi.snapshotAt`: the `Board` right after that cursor          |
| `GET /sync/:id?lineage=` (WebSocket)               | Document sync and presence, using the standard y-websocket protocol |
| `ALL /mcp`                                         | MCP over Streamable HTTP, mounted with `OpenBoardServer.mount`      |
| `GET /*`                                           | The web app                                                         |

Request and response bodies are the JSON forms of the `BoardApi` types. Errors are `{ "error": { "code", "message", "details" } }` with the HTTP status from `OpenBoardError.status`.

The long-poll is not cut by a server-side timeout (Node's request timeout only covers receiving the request), and a client that disconnects ends the wait at once. Missing proposals, batches and questions are `not_found` (404); acting on something already decided, answered or undone is `conflict` (409); a people-only or author-only call by someone else is `forbidden` (403).

The caller's actor is taken from the headers `x-openboard-actor-id`, `x-openboard-actor-name`, and `x-openboard-actor-kind`, and its agent session from `x-openboard-session`. Over the WebSocket the actor arrives as query parameters `actorId`, `actorName`, `actorKind`, next to the required `lineage`.

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
      server.json             { pid, port, url, root, version, startedAt } of the running server
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

The server binds to `127.0.0.1` by default. It rejects requests whose `Host` is not a loopback name, and rejects browser requests whose `Origin` is not its own, which closes the DNS-rebinding and cross-site paths to a local server. Board content is treated as untrusted input throughout: reads label who wrote what, so an agent can tell a teammate's note from an instruction.

## Conventions

- TypeScript, ES modules, Node 22 or newer. Relative imports carry the `.js` extension.
- Libraries build with `tsc -b` into `dist/`. The app builds with Vite.
- Validation at every boundary uses the Zod schemas in `core`; types are inferred from schemas, not written twice.
- Errors that cross a package boundary are `OpenBoardError`s with a stable `code`.
- Tests sit next to the code as `*.test.ts` and run with `pnpm test`.
- `pnpm lint` (Biome) and `pnpm typecheck` must pass.
