import {
  allExist,
  check,
  edgesExist,
  linkedNodes,
  neverSentCoordinates,
  noDuplicates,
  noReversedEdges,
  withinBudget,
} from '../checks.js';
import type { Scenario } from '../types.js';

const FILES: Record<string, string> = {
  'src/api/router.ts': `import { requireUser } from './auth.js';
import { listOrders } from '../orders/service.js';

export function route(path: string, token: string) {
  const user = requireUser(token);
  if (path === '/orders') return listOrders(user.id);
  throw new Error(\`no route for \${path}\`);
}
`,
  'src/api/auth.ts': `export function requireUser(token: string): { id: string } {
  if (!token) throw new Error('unauthorized');
  return { id: token.slice(0, 8) };
}
`,
  'src/orders/service.ts': `import { findOrders } from './repository.js';

export function listOrders(userId: string) {
  return findOrders({ userId, limit: 50 });
}
`,
  'src/orders/repository.ts': `import { query } from '../db/client.js';

export function findOrders(filter: { userId: string; limit: number }) {
  return query('select * from orders where user_id = $1 limit $2', [filter.userId, filter.limit]);
}
`,
  'src/db/client.ts': `export function query(sql: string, params: unknown[]) {
  return { sql, params, rows: [] as unknown[] };
}
`,
};

const API = /api/i;
const ORDERS = /order/i;
const DB = /\bdb\b|database|data/i;

const IMPORTS = [
  { from: { link: 'src/api/router.ts' }, to: { link: 'src/api/auth.ts' }, type: 'depends_on' },
  {
    from: { link: 'src/api/router.ts' },
    to: { link: 'src/orders/service.ts' },
    type: 'depends_on',
  },
  {
    from: { link: 'src/orders/service.ts' },
    to: { link: 'src/orders/repository.ts' },
    type: 'depends_on',
  },
  {
    from: { link: 'src/orders/repository.ts' },
    to: { link: 'src/db/client.ts' },
    type: 'depends_on',
  },
];

export const mapSmallRepo: Scenario = {
  id: 'map-small-repo',
  title: 'Map a small repository',
  description:
    'Map a five-file repository: a frame per area, a code node per file linked to it, and depends_on edges for the imports, in few batches.',
  tags: ['write', 'code', 'layout'],
  async setup(ctx) {
    for (const [file, content] of Object.entries(FILES)) await ctx.writeFile(file, content);
    await ctx.writeFile('package.json', '{ "name": "shop", "type": "module" }\n');
  },
  prompt:
    'Map this repository onto the board: one frame per area (src/api, src/orders, src/db), one code node per source file linked to its file, and a depends_on edge from each file to every file it imports. Only the five files under src/.',
  checks: [
    allExist(
      'a frame per area',
      [API, ORDERS, DB].map((title) => ({ pick: title, filter: { type: 'frame' } })),
    ),
    linkedNodes(
      'a code node per file, linked, in its area',
      [
        { target: 'src/api/router.ts', type: 'code', in: API },
        { target: 'src/api/auth.ts', type: 'code', in: API },
        { target: 'src/orders/service.ts', type: 'code', in: ORDERS },
        { target: 'src/orders/repository.ts', type: 'code', in: ORDERS },
        { target: 'src/db/client.ts', type: 'code', in: DB },
      ],
      2,
    ),
    edgesExist('depends_on edges for the imports', IMPORTS, 2),
    noReversedEdges('dependency direction', IMPORTS),
    noDuplicates(),
    neverSentCoordinates(),
    check('wrote the map in at most two batches', (ctx) => {
      const n = ctx.trace.calls.filter((c) => c.tool === 'board_apply' && !c.isError).length;
      return { pass: n >= 1 && n <= 2, detail: `${n} successful board_apply calls` };
    }),
    withinBudget({ maxToolCalls: 8 }),
  ],
  budget: { maxToolCalls: 8 },
  async reference({ call }) {
    await call('board_outline');
    const code = (ref: string, title: string, parent: string, target: string, body: string) => ({
      op: 'add_node',
      ref,
      node: { type: 'code', title, parent: `$${parent}`, body, links: [{ kind: 'file', target }] },
    });
    const dep = (source: string, target: string) => ({
      op: 'add_edge',
      edge: { type: 'depends_on', source: `$${source}`, target: `$${target}` },
    });
    await call('board_apply', {
      reason: 'Map of the repository',
      ops: [
        { op: 'add_node', ref: 'api', node: { type: 'frame', title: 'API' } },
        { op: 'add_node', ref: 'orders', node: { type: 'frame', title: 'Orders' } },
        { op: 'add_node', ref: 'db', node: { type: 'frame', title: 'Database' } },
        code(
          'router',
          'Router',
          'api',
          'src/api/router.ts',
          'Routes requests; requires a user first.',
        ),
        code('auth', 'Auth', 'api', 'src/api/auth.ts', 'Turns a token into a user.'),
        code(
          'service',
          'Orders service',
          'orders',
          'src/orders/service.ts',
          'Lists a user’s orders.',
        ),
        code('repo', 'Orders repository', 'orders', 'src/orders/repository.ts', 'SQL for orders.'),
        code('client', 'DB client', 'db', 'src/db/client.ts', 'Runs a query.'),
        dep('router', 'auth'),
        dep('router', 'service'),
        dep('service', 'repo'),
        dep('repo', 'client'),
      ],
    });
    return 'Mapped the five files into API, Orders and Database frames with their imports.';
  },
};
