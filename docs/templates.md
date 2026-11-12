# Templates

A template is a ready-made structure for a common kind of board: frames, nodes with short example text, and the edges between them. It is applied as one ordinary batch, so it goes through validation, the review policy, layout and history like any other change, and it fits an empty board, a busy one, or a frame.

## The built-in templates

| Id                 | Adds              | For                                                                                                                                            |
| ------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `feature-plan`     | 12 nodes, 6 edges | Planning one feature from goal to done: how success shows, tasks with dependencies and statuses, decisions with reasons, risks, open questions |
| `architecture-map` | 13 nodes, 8 edges | Mapping a codebase: areas as frames, important modules as code nodes linked to files, their dependencies, risks and open questions             |
| `release-plan`     | 15 nodes, 8 edges | Preparing and tracking a release, launch or migration: what is in it, what must happen first, rollout steps, how to roll back                  |
| `incident-review`  | 14 nodes, 7 edges | Looking back at an outage, data problem or near miss without blame: timeline, impact, causes, what will change                                 |
| `decision-record`  | 10 nodes, 5 edges | Recording one hard-to-reverse decision: the problem, the options with evidence for and against, the outcome and what follows                   |
| `research-map`     | 10 nodes, 7 edges | Organising research around a question: sources, the findings they support, how each bears on the question                                      |
| `kanban`           | 11 nodes, 3 edges | Working by stage (to do, in progress, review, done), for a small team or a group of agents                                                     |
| `agent-team`       | 13 nodes, 4 edges | Coordinating several agents on one board: a work queue, work in progress and who holds it, a review area for people                            |

Each makes one outer frame, titled with the template's name unless you give a title. Example text in the nodes shows what belongs there; replace it.

A project can add its own templates, or replace these, with board files in `.openboard/templates/`, and plugins can add more; see [Extending OpenBoard](extending.md#project-templates).

## On the canvas

**Insert template…**, in the command palette (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd>) or the board menu, opens a gallery of the templates: pick one, optionally name it and put it in a frame, see what it adds, then insert it. **New board** offers the same gallery to start a board from.

## From the command line

```bash
openboard templates                                   # list them: built-in, the project's, a running server's plugins'
openboard new "CSV export" --template feature-plan    # a new board that starts from one
openboard template apply kanban                       # onto the main board
openboard template apply decision-record main --frame <frame id> --title "Pick a queue" --dry-run
```

`--dry-run` checks the template against the board and says what it would add without changing anything. With a server running, the template is applied through it as you; without one, it is written to the board file, and the new nodes are placed by the next automatic layout.

## For agents

Agents list and apply templates with [`board_template`](tools.md#board_template), and `board_create` takes a `template` too. An agent's template is a batch like any other: under the default policy it lands at once on an empty board or in its own area, and it is held for review when it changes what people made. The server instructions and the agent guides suggest starting a new board or area from a template when one fits.
