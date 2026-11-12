# Board file format

Each board is one file, `.openboard/<board id>.board.json`, in the project it belongs to. The file is the source of truth: the running server keeps it up to date, and it picks up changes made to it from outside (a checkout, a merge, an editor). This page is for people who review board diffs in pull requests and for anyone writing tools that read or write the file.

The schema is defined in [`packages/core/src/schema.ts`](../packages/core/src/schema.ts) and the writer in [`packages/core/src/serialize.ts`](../packages/core/src/serialize.ts).

## Example

An excerpt of a real board file: a frame, a task in it, and one of the task's edges. The edge's target node is cut from the excerpt, so the excerpt on its own would not pass the rules below.

```json
{
  "schemaVersion": 1,
  "id": "main",
  "name": "proj",
  "createdAt": "2026-11-12T04:47:05.672Z",
  "updatedAt": "2026-11-12T04:47:59.542Z",
  "actors": {
    "ada": {
      "id": "ada",
      "kind": "human",
      "name": "Ada"
    },
    "claude-code": {
      "id": "claude-code",
      "kind": "agent",
      "name": "Claude Code"
    }
  },
  "nodes": {
    "n_3wdy9zd494": {
      "id": "n_3wdy9zd494",
      "type": "task",
      "title": "Export button",
      "status": "todo",
      "parent": "n_cgfi6dcohk",
      "body": "Done when: the orders page downloads the CSV for the current filter.",
      "view": {
        "x": 80,
        "y": 576
      },
      "createdBy": "claude-code",
      "createdAt": "2026-11-12T04:47:06.094Z",
      "updatedBy": "claude-code",
      "updatedAt": "2026-11-12T04:47:06.094Z"
    },
    "n_cgfi6dcohk": {
      "id": "n_cgfi6dcohk",
      "type": "frame",
      "title": "CSV export",
      "view": {
        "x": 0,
        "y": 0,
        "w": 640,
        "h": 752
      },
      "createdBy": "claude-code",
      "createdAt": "2026-11-12T04:47:06.094Z",
      "updatedBy": "claude-code",
      "updatedAt": "2026-11-12T04:47:06.094Z"
    }
  },
  "edges": {
    "e_5ekev68n5j": {
      "id": "e_5ekev68n5j",
      "type": "depends_on",
      "source": "n_3wdy9zd494",
      "target": "n_afbidkzaw8",
      "createdBy": "claude-code",
      "createdAt": "2026-11-12T04:47:06.094Z",
      "updatedBy": "claude-code",
      "updatedAt": "2026-11-12T04:47:06.094Z"
    }
  }
}
```

## Fields

### Board

| Field                    | Type                            | Meaning                                      |
| ------------------------ | ------------------------------- | -------------------------------------------- |
| `schemaVersion`          | `1`                             | Version of this format                       |
| `id`                     | id                              | Board id; matches the file name              |
| `name`                   | string, 1 to 120 characters     | Display name                                 |
| `description`            | string, at most 2000 characters | Optional                                     |
| `createdAt`, `updatedAt` | ISO 8601 timestamp              | `updatedAt` moves on semantic changes only   |
| `actors`                 | object of actors by id          | Everyone who authored something on the board |
| `nodes`                  | object of nodes by id           |                                              |
| `edges`                  | object of edges by id           |                                              |

Ids are letters, digits and `_ . : -`, starting with a letter or digit, at most 64 characters. Generated ids are `n_` (nodes) or `e_` (edges) followed by ten lowercase letters and digits. Every key in `actors`, `nodes` and `edges` equals the `id` inside it, and no id is used by both a node and an edge.

### Actor

| Field   | Type                       | Meaning                                                                                                         |
| ------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `id`    | id                         | `cli` for the command line, the client name for an agent (`claude-code`), or the id a person or agent was given |
| `kind`  | `human`, `agent`, `system` |                                                                                                                 |
| `name`  | string, 1 to 80 characters | Display name                                                                                                    |
| `color` | string                     | Optional                                                                                                        |

### Node

| Field                    | Type                        | Meaning                                                                                                                             |
| ------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | id                          |                                                                                                                                     |
| `type`                   | node type                   | `note`, `task`, `decision`, `question`, `risk`, `doc`, `code`, `agent`, `run`, `frame`, or a custom `x:name`                        |
| `title`                  | string, 1 to 200 characters |                                                                                                                                     |
| `status`                 | status                      | Optional: `todo`, `in_progress`, `blocked`, `done`, `cancelled`                                                                     |
| `parent`                 | id                          | Optional: the frame the node sits in                                                                                                |
| `tags`                   | string[]                    | Optional, at most 20, each 1 to 40 characters                                                                                       |
| `body`                   | string                      | Optional markdown, at most 20000 characters                                                                                         |
| `links`                  | link[]                      | Optional, at most 50: `{ kind, target, line?, endLine?, hash?, stale? }` with `kind` one of `file`, `symbol`, `commit`, `pr`, `url` |
| `props`                  | object                      | Optional free-form JSON                                                                                                             |
| `view`                   | object                      | Optional presentation: `x`, `y`, `w`, `h`, `pinned`, `collapsed`, `color`                                                           |
| `createdBy`, `createdAt` | actor id, timestamp         | Who created it, and when                                                                                                            |
| `updatedBy`, `updatedAt` | actor id, timestamp         | Who last changed its meaning, and when                                                                                              |

`view.x` and `view.y` are relative to the top-left corner of the parent frame, or to the canvas origin for a node without a parent, so moving a frame does not rewrite its children. `pinned: true` means a person placed the node and automatic layout leaves it alone. A node without `view` has not been placed yet; the server places it.

### Edge

| Field                                              | Type                           | Meaning                                                                                              |
| -------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `id`                                               | id                             |                                                                                                      |
| `type`                                             | edge type                      | `relates_to`, `depends_on`, `blocks`, `implements`, `evidence_for`, `flows_to`, or a custom `x:name` |
| `source`, `target`                                 | node id                        | The edge points from `source` to `target`                                                            |
| `label`                                            | string, at most 120 characters | Optional                                                                                             |
| `createdBy`, `createdAt`, `updatedBy`, `updatedAt` |                                | As for nodes                                                                                         |

## Rules

A file that breaks any of these is invalid:

- It is valid JSON and matches the schema above.
- A node's `parent` is an existing node of type `frame`, and following `parent` never loops.
- An edge's `source` and `target` exist and differ.
- There is at most one edge per (`type`, `source`, `target`).

## Determinism

The same board always produces byte-identical output, so a small change on the board is a small diff:

- Two-space indentation, and a newline at the end of the file.
- Known fields always appear in the order of the tables above: board fields, then `actors`, `nodes`, `edges`; within a node, `id`, `type`, `title`, `status`, `parent`, `tags`, `body`, `links`, `props`, `view`, then the four bookkeeping fields. Within a link: `kind`, `target`, `line`, `endLine`, `hash`, `stale`. Within a view: `x`, `y`, `w`, `h`, `pinned`, `collapsed`, `color`.
- `actors`, `nodes` and `edges` are sorted by id, in plain code-unit order, independent of locale.
- Keys inside `props` are sorted at every depth.
- Optional fields that carry nothing are left out: no empty `body`, `tags`, `links`, `props` or `label`, and no `null`s. Absent has exactly one representation.
- Every scalar field sits on its own line, so changing one field changes one line.

What that means in a review:

- **Moves are separate from meaning.** Dragging a node changes only lines inside its `view`. A change to `title`, `body`, `status` and so on also changes `updatedBy` and `updatedAt`; a move does not.
- **Who did it is in the diff.** `createdBy` and `updatedBy` name the actor, and new actors appear in `actors`.
- **Layout adds `view` blocks.** A batch from an agent usually shows new nodes with a `view` the layout engine chose, and sometimes changed `w`/`h` on a frame that grew.

## What is stored, and what is not

Stored in the board file: the board's metadata, its actors, and every node and edge with their content, presentation and authorship.

Not stored in the board file:

| Kept elsewhere                                     | Where                                        |
| -------------------------------------------------- | -------------------------------------------- |
| The change feed behind `board_changes` and cursors | `.openboard/.local/<board id>.changes.jsonl` |
| Document state with history, for fast restarts     | `.openboard/.local/<board id>.ydoc`          |
| The running server's address and process id        | `.openboard/.local/server.json`              |

Not stored anywhere: who is connected, their pointers and selections (these travel live between browsers and the server), the `reason` of an agent's batch, and MCP session state.

`.openboard/.local/` holds a `.gitignore` containing `*`, so git ignores it without changes to your own `.gitignore`. Deleting `.local/` loses the change history and resets cursors; the boards themselves are safe in their files.

## Editing the file

You can edit a board file by hand, or let git change it through a checkout, merge or rebase. While a server runs, it notices the change and reconciles the live board to match the file; browsers update on their own. Agents see such changes in `board_changes`, attributed to the actor `system`. The node keeps whatever `updatedBy` and `updatedAt` the file says.

If the file stops parsing, for example because a merge left conflict markers in it, the server keeps serving the board as it was and does not overwrite the file until it parses again. Fix the file, or check out a good version; `openboard doctor` names a file that does not parse and why.

To create a board without the server, write a file with an empty `actors`, `nodes` and `edges`, or run `openboard new`. To produce the canonical form of a board, run `openboard export <board> --format json`.

## Schema version

Files carry `"schemaVersion": 1`. A file with any other value does not parse.
