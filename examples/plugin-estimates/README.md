# Example plugin: estimates

A small OpenBoard plugin that shows each thing a plugin can do:

- **A node type.** `x:estimate`, with the fields `points` (number, required), `confidence` (low, medium, high), `owner`, `due` (date) and `notes`. The server checks them when a batch is applied, and reads show them with their labels.
- **A template.** `estimation`: a frame with two example estimates and what they cover.
- **An export format.** `csv`: one row per estimate, served by `GET /api/boards/<id>/export?format=csv` as `text/csv`.
- **A hook.** After every batch that changes a board, it updates a note titled `Estimate total: N points` (it adds the note the first time a board has an estimate).

It is one plain ES module, [`index.js`](index.js), and uses `@openboard/core` for types only. `createEstimatesPlugin()` makes an instance; use one per server.

## Use it

Plugins are code, so a server never loads them by itself: pass them when you start it.

```js
import { startServer } from '@openboard/server';
import { createEstimatesPlugin } from './examples/plugin-estimates/index.js';

const server = await startServer({ root: process.cwd(), plugins: [createEstimatesPlugin()] });
console.log(`serving at ${server.url}`);
```

Then, for example:

```sh
curl -s "$URL/api/templates"
curl -s -X POST "$URL/api/boards/main/template" -H 'content-type: application/json' \
  -d '{"template": "estimation"}'
curl -s "$URL/api/boards/main/export?format=csv"
```

`GET /api/info` lists the plugin, its version, and any warning about it, such as a type that the project's `.openboard/config.json` declares as well (the project's definition wins).

## Writing your own

A plugin is an object of type `OpenBoardPlugin` from `@openboard/core` (`definePlugin` gives it the type in TypeScript). Every part is optional except `name`. See "Plugins" in [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the rules: names, types, template ids and format names must not clash with another plugin's, hooks run one at a time per plugin and never hold up an apply, and `setup` may return a teardown that runs when the server closes.
