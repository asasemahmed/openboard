# Extending OpenBoard

A board has ten built-in node types and six edge types. A project can add its own in three ways, from lightest to heaviest:

1. **Declared types** in `.openboard/config.json`: node and edge types with a label, a description, a colour, an icon and typed fields. No code.
2. **Project templates** in `.openboard/templates/`: board files that people and agents can stamp onto a board. No code.
3. **Plugins**: JavaScript modules that add types, templates, export and import formats, and code that reacts to changes. They run inside the server, so they are loaded only when you name them on the command line.

The exact rules are in [ARCHITECTURE.md](ARCHITECTURE.md#types-templates-and-plugins).

## Declaring types

Any type named `x:<name>` is accepted on a board without being declared. Declaring it gives it a meaning that agents and people can read, a look on the canvas, and fields that are checked. Add `nodeTypes` and `edgeTypes` next to the review policy in `.openboard/config.json`:

```json
{
  "version": 1,
  "policy": { "default": "review_destructive", "agents": {} },
  "nodeTypes": {
    "x:experiment": {
      "label": "Experiment",
      "description": "A test of an idea, with what would prove it wrong.",
      "color": "teal",
      "icon": "beaker",
      "hasStatus": true,
      "fields": [
        { "key": "hypothesis", "label": "Hypothesis", "kind": "text", "required": true },
        {
          "key": "method",
          "label": "Method",
          "kind": "longtext",
          "description": "How it is run, step by step."
        },
        { "key": "sampleSize", "label": "Sample size", "kind": "number" },
        { "key": "blinded", "label": "Blinded", "kind": "boolean" },
        {
          "key": "confidence",
          "label": "Confidence",
          "kind": "select",
          "options": ["low", "medium", "high"]
        },
        { "key": "due", "label": "Due", "kind": "date" },
        { "key": "dashboard", "label": "Dashboard", "kind": "url" }
      ]
    }
  },
  "edgeTypes": {
    "x:supersedes": {
      "label": "Supersedes",
      "description": "The source replaces the target.",
      "style": "dashed",
      "directed": true
    }
  }
}
```

| Field kind | A value is                                |
| ---------- | ----------------------------------------- |
| `text`     | one line, at most 1000 characters         |
| `longtext` | several lines, at most 20000 characters   |
| `number`   | a finite number                           |
| `boolean`  | `true` or `false`                         |
| `select`   | one of `options` (required for this kind) |
| `date`     | an ISO date such as `2026-11-12`          |
| `url`      | an http or https URL                      |

A field's value lives in the node's `props` under its `key` (`props.hypothesis`); other props are allowed. `null`, `""` and a missing key all mean "no value", which only `required` refuses. `hasStatus: false` refuses a status on nodes of that type.

Colours: `gray`, `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `indigo`, `purple`, `pink`. Icons: `box`, `circle`, `star`, `flag`, `bookmark`, `tag`, `user`, `users`, `bot`, `bug`, `bolt`, `beaker`, `chart`, `clock`, `calendar`, `check`, `alert`, `lightbulb`, `link`, `file`, `code`, `database`, `server`, `target`. Edge styles: `solid`, `dashed`, `thick`. At most 50 node types and 30 edge types, 30 fields per type.

**How it is checked.** Batches applied through the API (agents, the CLI, imports, templates, accepted proposals) are checked against the declared types, and a problem refuses the batch with a message such as `props.confidence must be one of low, medium, high (got "sure") for x:experiment nodes`. Existing nodes are checked only on what a batch touches, so tightening a type later never makes old nodes uneditable. `openboard types check` lists the nodes that do not fit, for example ones made before a type changed or edited in a browser (browser edits are not checked by the server). `openboard types` prints every type; agents read the same with `board_schema`, and the outline tells them when a board has custom types.

A running server picks up changes to `config.json` at once. Commit the file.

## Card colours

Each card type has one OKLCH hue, `--tone-h`, in its `.tone-*` class in
[`tokens.css`](../packages/app/src/styles/tokens.css). Theme tokens turn that hue into
the card fill (`--fill-l`, `--fill-c`), its edge (`--fill-line-l`, `--fill-line-c`),
and the type label (`--label-l`, `--label-c`). `l` controls lightness and `c` controls
chroma. `--tone-cx` scales the fill and edge chroma for a particular type and
defaults to 1; the label multiplier is capped at 1.
The light theme uses pale fills and dark labels; the dark theme reverses their
lightness. Both the system dark-theme block and the explicit dark-theme block
define the same tokens.

When adding a card colour, update both renderers:

1. In `tokens.css`, add or adjust the `.tone-*` hue and its `--tone` palette token.
   Define any new palette token in the light theme and both dark-theme blocks.
2. In [`svg-theme.ts`](../packages/core/src/interop/svg-theme.ts), add the matching
   hex colours to `types`, `fills`, and `fillLines` in `LIGHT_THEME` and `DARK_THEME`.
   SVG exports embed these values so they work without the app's CSS.

Type labels must have at least **4.5:1** contrast against their card fill in both
themes. Palette tokens used on neutral surfaces must also meet **4.5:1** against
`--card` (and, for declared-type colours, `--sunken`). Check the rendered colours,
including any chroma scaling, rather than assuming the shared lightness guarantees
contrast. Adding a new name to the declared-type colour vocabulary also requires
updating `TYPE_COLORS` in core.

## Project templates

A template is a ready-made structure applied to a board as one batch. Eight are built in ([templates.md](templates.md)). Any board file in `.openboard/templates/<name>.board.json` is a project template with the id `<name>`; it replaces a built-in template of that id. Make one from an existing board:

```bash
openboard template save launch-plan            # the main board, as .openboard/templates/launch-plan.board.json
openboard new "Q3 launch" --template launch-plan
```

Applying a project template copies its nodes, edges and positions with fresh ids. Comments are not copied, and code links are checked afresh. Commit the templates folder to share them.

## Writing a plugin

A plugin is an object with a `name` and any of `version`, `nodeTypes`, `edgeTypes`, `templates`, `exporters`, `importers`, `onBatch` and `setup`. It depends on `@openboard/core` for its types only (`OpenBoardPlugin`, `definePlugin`). [`examples/plugin-estimates`](../examples/plugin-estimates/) shows each part:

- **A node type**, `x:estimate`, with the fields `points` (a required number), `confidence` (a select), `owner`, `due` and `notes`. A plugin's types are checked like the project's; the project's `config.json` wins a clash, and the plugin gets a warning.
- **A template**, `estimation`: `{ id, name, description, tags, build(options) }`, where `build` returns operations that use `ref`s, so it fits any board.
- **An export format**, `csv`: `{ name, extension, mime, description, render(board) }`. It is served by `openboard export --format csv` while the server that loaded the plugin runs.
- **A hook**, `onBatch`, called after every batch that changed nodes or edges, one at a time and never holding up the batch. Here it keeps a note with the total of points up to date, through the in-process API that `setup` received, as a `system` actor that the review policy does not hold up.

```js
export function createEstimatesPlugin() {
  return {
    name: 'estimates',
    version: '1.0.0',
    nodeTypes: {
      'x:estimate': {
        label: 'Estimate',
        fields: [
          /* ... */
        ],
      },
    },
    templates: [
      {
        id: 'estimation',
        name: 'Estimation',
        description: '...',
        tags: [],
        build: () => [
          /* ops */
        ],
      },
    ],
    exporters: [
      { name: 'csv', extension: '.csv', mime: 'text/csv', description: '...', render: toCsv },
    ],
    setup(ctx) {
      /* ctx.api(actor), ctx.log(line), ctx.root; may return a teardown */
    },
    onBatch(event) {
      /* event.boardId, event.batch, event.board() */
    },
  };
}
export default createEstimatesPlugin();
```

The module's default export, or a named export `plugin`, is the plugin; it may also be a function that returns one (it is called once per server).

## Loading a plugin

```bash
openboard start --plugin ./examples/plugin-estimates/index.js
openboard start --plugin @acme/openboard-risk --plugin ./tools/board-plugin.js
```

`--plugin` takes a path to a module, or the name of a package installed for the current directory, and can be given several times. `start` prints each loaded plugin and its warnings, and `openboard doctor` lists them. `openboard mcp --plugin <module>` passes the same flags to the server it starts in the background; it cannot add plugins to a server that is already running.

**Plugins are code with the server's privileges.** A plugin can read and write every board and any file your user can, and talk to the network. So OpenBoard never loads one on its own: not from `config.json`, not from the project directory, not from a dependency. The `--plugin` flag, typed by the person starting the server, is the decision to trust it. Review a plugin before you load it, as you would any dependency.

**Per-server isolation.** Everything a plugin adds lives on the server instance that loaded it: another server in the same process, or another project, does not see its types, templates or formats. Two plugins may not declare the same name, type, template id or format name; the server refuses to start and names both.
