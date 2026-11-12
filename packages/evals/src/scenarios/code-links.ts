import { calledTool, check, nodeExists, nodesUnchanged } from '../checks.js';
import { idOf } from '../reference.js';
import type { Scenario } from '../types.js';
import { frame, keep, node } from './util.js';

const V1 = `// Prices are in cents.
export interface LineItem { price: number; quantity: number }

export function computeTotal(items: LineItem[]): number {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return subtotal;
}

export function applyDiscount(total: number, percent: number): number {
  return total * (1 - percent / 100);
}
`;

const V2 = V1.replace('// Prices are in cents.', 'export const TAX_RATE = 0.2;').replace(
  '  return subtotal;',
  '  return Math.round(subtotal * (1 + TAX_RATE));',
);

export const keepBoardTrueToCode: Scenario = {
  id: 'keep-board-true-to-code',
  title: 'Keep the board true to the code',
  description:
    'A linked function changed after the board was made, so its link is stale. The agent must find it with board_links, update the node from the code, and refresh only what it re-checked.',
  tags: ['code', 'links'],
  async setup(ctx) {
    await ctx.writeFile('src/pricing.ts', V1);
    const file = 'src/pricing.ts';
    const refs = await ctx.apply(
      [
        frame('f', 'Pricing'),
        node('total', 'code', 'computeTotal()', {
          parent: '$f',
          body: 'Sums price times quantity over the line items.',
          links: [{ kind: 'file', target: file, line: 4, endLine: 7 }],
        }),
        node('discount', 'code', 'applyDiscount()', {
          parent: '$f',
          body: 'Takes a percentage off a total.',
          links: [{ kind: 'file', target: file, line: 9, endLine: 11 }],
        }),
      ],
      { as: ctx.agent },
    );
    keep(ctx.ids, refs, ['total', 'discount']);
    await ctx.waitFor(async () => {
      const links = await ctx.owner.links(ctx.board, {});
      return links.links.length === 2 && links.links.every((l) => l.state === 'ok');
    }, 'the links to be hashed');
    await ctx.writeFile(file, V2);
    await ctx.waitFor(async () => {
      const links = await ctx.owner.links(ctx.board, { stale: true });
      return links.links.some((l) => l.nodeId === ctx.ids.total && l.state === 'stale');
    }, 'the computeTotal link to go stale');
  },
  prompt:
    'The code changed since the board was last updated. Bring the board up to date with the code.',
  checks: [
    calledTool('looked for stale links with board_links', 'board_links', {
      args: (a) => a.refresh === undefined,
    }),
    nodeExists('computeTotal() now mentions tax', { key: 'total' }, { body: /tax/i }, 2),
    check(
      'no link is stale any more',
      async (ctx) => {
        const links = await ctx.owner.links(ctx.boardId, { stale: true });
        return {
          pass: links.links.length === 0,
          detail:
            links.links.length === 0
              ? 'all links match the code'
              : links.links.map((l) => `${l.title} ${l.state}`).join(', '),
        };
      },
      2,
    ),
    nodesUnchanged('applyDiscount() is untouched', [{ key: 'discount' }]),
    check('refreshed only what it re-checked', (ctx) => {
      const refreshed = ctx.trace.calls
        .filter((c) => c.tool === 'board_links' && c.args.refresh !== undefined)
        .flatMap((c) => (Array.isArray(c.args.refresh) ? (c.args.refresh as string[]) : ['all']));
      const extra = refreshed.filter((id) => id !== ctx.ids.total);
      return {
        pass: refreshed.length > 0 && extra.length === 0,
        detail:
          refreshed.length === 0
            ? 'never refreshed'
            : extra.length
              ? `also refreshed ${extra.join(', ')}`
              : 'refreshed computeTotal() only',
      };
    }),
  ],
  async reference({ call }) {
    const stale = await call('board_links');
    const id = idOf(stale.text, 'computeTotal()');
    // An agent reads src/pricing.ts here with its own file tools.
    await call('board_apply', {
      reason: 'computeTotal now adds tax',
      ops: [
        {
          op: 'update_node',
          id,
          patch: {
            body: 'Sums price times quantity over the line items, then adds tax at TAX_RATE (20%) and rounds.',
          },
        },
      ],
    });
    await call('board_links', { refresh: [id] });
    return 'Updated computeTotal() for the tax change and refreshed its link.';
  },
};
