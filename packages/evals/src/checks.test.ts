import type { Actor, Board, BoardEdge, BoardNode } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import {
  calledBefore,
  checkedInbox,
  claimedBeforeEditing,
  edgesExist,
  humanNodesUntouched,
  linkedNodes,
  neverSentCoordinates,
  noDuplicates,
  nodeExists,
  nodesUnchanged,
  noResentProposal,
  noReversedEdges,
  nothingOutsideFrame,
  nothingRemoved,
  selectionBeforeActing,
  statusEquals,
  targetedReads,
  withinBudget,
} from './checks.js';
import { emptyTrace } from './trace.js';
import type { Check, CheckContext, ToolCallRecord } from './types.js';

const AT = '2026-11-12T00:00:00.000Z';
const ADA: Actor = { id: 'ada', kind: 'human', name: 'Ada' };
const AGENT: Actor = { id: 'eval-agent', kind: 'agent', name: 'Agent' };

function n(id: string, title: string, extra: Partial<BoardNode> = {}): BoardNode {
  return {
    id,
    type: 'task',
    title,
    createdBy: 'ada',
    createdAt: AT,
    updatedBy: 'ada',
    updatedAt: AT,
    ...extra,
  };
}

function e(id: string, type: string, source: string, target: string): BoardEdge {
  return {
    id,
    type,
    source,
    target,
    createdBy: 'eval-agent',
    createdAt: AT,
    updatedBy: 'eval-agent',
    updatedAt: AT,
  };
}

function board(nodes: BoardNode[], edges: BoardEdge[] = []): Board {
  return {
    id: 'main',
    name: 'Main',
    createdAt: AT,
    updatedAt: AT,
    schemaVersion: 1,
    actors: { ada: ADA, 'eval-agent': AGENT },
    nodes: Object.fromEntries(nodes.map((x) => [x.id, x])),
    edges: Object.fromEntries(edges.map((x) => [x.id, x])),
  } as Board;
}

let seq = 0;
function call(
  tool: string,
  args: Record<string, unknown> = {},
  text = '',
  extra: Partial<ToolCallRecord> = {},
): ToolCallRecord {
  seq++;
  return {
    seq,
    connection: 1,
    tool,
    args,
    text,
    isError: false,
    startedMs: seq,
    durationMs: 1,
    argsTokens: 10,
    resultTokens: 100,
    ...extra,
  };
}

function ctx(
  final: Board,
  calls: ToolCallRecord[] = [],
  over: Partial<CheckContext> = {},
): CheckContext {
  const trace = emptyTrace();
  trace.calls = calls.map((c, i) => ({ ...c, seq: i + 1 }));
  return {
    board: final,
    initial: final,
    trace,
    ids: {},
    metrics: {},
    agentId: 'eval-agent',
    humanId: 'ada',
    root: '/tmp/x',
    owner: {} as CheckContext['owner'],
    boardId: 'main',
    finalText: undefined,
    human: [],
    ...over,
  };
}

const run = async (c: Check, context: CheckContext) => c.run(context);

describe('board checks', () => {
  const frame = n('n_f', 'API', { type: 'frame' });
  const code = n('n_c', 'Router', {
    type: 'code',
    parent: 'n_f',
    links: [{ kind: 'file', target: 'src/api/router.ts', hash: 'abc' }],
  });
  const other = n('n_o', 'Auth', {
    type: 'code',
    parent: 'n_f',
    links: [{ kind: 'file', target: './src/api/auth.ts' }],
  });
  const b = board([frame, code, other], [e('e_1', 'depends_on', 'n_c', 'n_o')]);

  it('finds nodes by title, type, frame, status and body', async () => {
    expect((await run(nodeExists('x', 'router', { type: 'code', in: /api/i }), ctx(b))).pass).toBe(
      true,
    );
    expect((await run(nodeExists('x', 'Router', { type: 'task' }), ctx(b))).pass).toBe(false);
    expect((await run(nodeExists('x', /rout/, { in: 'Nope' }), ctx(b))).pass).toBe(false);
    const withBody = board([n('n_t', 'T', { body: 'adds tax', status: 'done' })]);
    expect(
      (await run(nodeExists('x', 'T', { body: /tax/, status: 'done' }), ctx(withBody))).pass,
    ).toBe(true);
    const wrong = await run(nodeExists('x', 'T', { status: 'todo' }), ctx(withBody));
    expect(wrong.pass).toBe(false);
    expect(wrong.detail).toContain('done');
  });

  it('checks links, with partial credit and ./ prefixes ignored', async () => {
    const result = await run(
      linkedNodes('links', [
        { target: 'src/api/router.ts', type: 'code', in: 'API' },
        { target: 'src/api/auth.ts', type: 'code' },
        { target: 'src/db/client.ts' },
      ]),
      ctx(b),
    );
    expect(result.pass).toBe(false);
    expect(result.score).toBeCloseTo(2 / 3);
    expect(result.detail).toContain('src/db/client.ts');
  });

  it('checks edges and their direction', async () => {
    const wanted = [{ from: { link: 'src/api/router.ts' }, to: 'Auth', type: 'depends_on' }];
    expect((await run(edgesExist('e', wanted), ctx(b))).pass).toBe(true);
    expect((await run(noReversedEdges('r', wanted), ctx(b))).pass).toBe(true);
    const reversed = board([frame, code, other], [e('e_1', 'depends_on', 'n_o', 'n_c')]);
    expect((await run(edgesExist('e', wanted), ctx(reversed))).pass).toBe(false);
    expect((await run(noReversedEdges('r', wanted), ctx(reversed))).pass).toBe(false);
  });

  it('checks a status by setup key', async () => {
    const c = ctx(board([n('n_t', 'T', { status: 'done' })]), [], { ids: { t: 'n_t' } });
    expect((await run(statusEquals('s', { key: 't' }, 'done'), c)).pass).toBe(true);
    expect((await run(statusEquals('s', { key: 't' }, 'todo'), c)).pass).toBe(false);
    expect((await run(statusEquals('s', { key: 'missing' }, 'todo'), c)).pass).toBe(false);
  });

  it('counts only duplicates the agent made', async () => {
    const initial = board([n('n_a', 'Same'), n('n_b', 'Same')]);
    const ok = ctx(initial, [], { initial });
    expect((await run(noDuplicates(), ok)).pass).toBe(true);
    const more = board([n('n_a', 'Same'), n('n_b', 'Same'), n('n_c', 'same ')]);
    expect((await run(noDuplicates(), ctx(more, [], { initial }))).pass).toBe(false);
    const differentType = board([
      n('n_a', 'Same'),
      n('n_b', 'Same'),
      n('n_c', 'Same', { type: 'note' }),
    ]);
    expect((await run(noDuplicates(), ctx(differentType, [], { initial }))).pass).toBe(true);
  });

  it('finds what the agent added outside a frame', async () => {
    const initial = board([frame]);
    const inside = board([frame, n('n_x', 'X', { parent: 'n_f', createdBy: 'eval-agent' })]);
    expect((await run(nothingOutsideFrame('o', 'API'), ctx(inside, [], { initial }))).pass).toBe(
      true,
    );
    const outside = board([frame, n('n_x', 'X', { createdBy: 'eval-agent' })]);
    const result = await run(nothingOutsideFrame('o', 'API'), ctx(outside, [], { initial }));
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('"X"');
    // Nodes people add are not the agent's doing.
    const theirs = board([frame, n('n_x', 'X')]);
    expect((await run(nothingOutsideFrame('o'), ctx(theirs, [], { initial }))).pass).toBe(true);
  });

  it('sees changed, removed and allowed human nodes, ignoring presentation and link hashes', async () => {
    const initial = board([
      n('n_a', 'A', { view: { x: 0, y: 0 }, links: [{ kind: 'file', target: 'a.ts' }] }),
      n('n_b', 'B'),
      n('n_mine', 'Mine', { createdBy: 'eval-agent' }),
    ]);
    const moved = board([
      n('n_a', 'A', {
        view: { x: 50, y: 9 },
        updatedAt: '2026-11-12T01:00:00.000Z',
        links: [{ kind: 'file', target: 'a.ts', hash: 'h', stale: true }],
      }),
      n('n_b', 'B'),
      n('n_mine', 'Mine changed', { createdBy: 'eval-agent' }),
    ]);
    expect((await run(humanNodesUntouched(), ctx(moved, [], { initial }))).pass).toBe(true);
    const edited = board([n('n_a', 'A', { status: 'done' })]);
    const result = await run(humanNodesUntouched(), ctx(edited, [], { initial }));
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('"A"');
    expect(result.detail).toContain('"B" (removed)');
    expect(
      (await run(humanNodesUntouched('h', ['A', 'B']), ctx(edited, [], { initial }))).pass,
    ).toBe(true);
    expect((await run(nodesUnchanged('u', ['A']), ctx(edited, [], { initial }))).pass).toBe(false);
    expect((await run(nothingRemoved(), ctx(edited, [], { initial }))).pass).toBe(false);
    expect((await run(nothingRemoved(), ctx(moved, [], { initial }))).pass).toBe(true);
  });
});

describe('trace checks', () => {
  const b = board([n('n_t', 'T')]);
  const proposed = 'Proposed as p_1: the batch is waiting for a person to review it on the board.';
  const ops = [{ op: 'update_node', id: 'n_t', patch: { status: 'done' } }];

  it('catches a re-sent proposal and a remove-and-re-add workaround', async () => {
    const clean = [call('board_apply', { ops }, proposed), call('board_inbox')];
    expect((await run(noResentProposal(), ctx(b, clean))).pass).toBe(true);
    const resent = [call('board_apply', { ops }, proposed), call('board_apply', { ops }, proposed)];
    expect((await run(noResentProposal(), ctx(b, resent))).detail).toContain('re-sent');
    const workaround = [
      call('board_apply', { ops }, proposed),
      call('board_apply', {
        ops: [
          { op: 'remove_node', id: 'n_t' },
          { op: 'add_node', node: { type: 'task', title: 'T' } },
        ],
      }),
    ];
    const result = await run(noResentProposal(), ctx(b, workaround));
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('removes n_t');
  });

  it('orders calls', async () => {
    const good = [call('board_selection'), call('board_apply', { ops })];
    expect((await run(selectionBeforeActing(), ctx(b, good))).pass).toBe(true);
    const viaRead = [call('board_read', { selection: true }), call('board_apply', { ops })];
    expect((await run(selectionBeforeActing(), ctx(b, viaRead))).pass).toBe(true);
    const bad = [call('board_apply', { ops }), call('board_selection')];
    expect((await run(selectionBeforeActing(), ctx(b, bad))).pass).toBe(false);
    expect(
      (await run(calledBefore('x', 'board_ask', 'board_apply'), ctx(b, [call('board_ask')])))
        .detail,
    ).toContain('never happened');
  });

  it('flags coordinates', async () => {
    expect((await run(neverSentCoordinates(), ctx(b, [call('board_apply', { ops })]))).pass).toBe(
      true,
    );
    const moved = [
      call('board_apply', { ops: [{ op: 'move_node', id: 'n_t', view: { x: 1, y: 2 } }] }),
    ];
    expect((await run(neverSentCoordinates(), ctx(b, moved))).pass).toBe(false);
    const placed = [
      call('board_apply', {
        ops: [{ op: 'add_node', node: { type: 'note', title: 'x', view: { x: 1, y: 1 } } }],
      }),
    ];
    expect((await run(neverSentCoordinates(), ctx(b, placed))).pass).toBe(false);
  });

  it('checks the inbox after a given call', async () => {
    const after = (c: ToolCallRecord) => c.tool === 'board_apply';
    expect(
      (
        await run(
          checkedInbox('i', after),
          ctx(b, [call('board_apply', { ops }), call('board_inbox')]),
        )
      ).pass,
    ).toBe(true);
    expect(
      (
        await run(
          checkedInbox('i', after),
          ctx(b, [call('board_inbox'), call('board_apply', { ops })]),
        )
      ).pass,
    ).toBe(false);
    expect((await run(checkedInbox(), ctx(b, [call('board_outline')]))).pass).toBe(false);
  });

  it('wants a claim before the edit', async () => {
    const c = (calls: ToolCallRecord[]) => ctx(b, calls, { ids: { t: 'n_t' } });
    const claim = call('board_claim', { nodeIds: ['n_t'] });
    const edit = call('board_apply', { ops });
    expect((await run(claimedBeforeEditing({ key: 't' }), c([claim, edit]))).pass).toBe(true);
    expect((await run(claimedBeforeEditing({ key: 't' }), c([edit, claim]))).pass).toBe(false);
    expect((await run(claimedBeforeEditing({ key: 't' }), c([edit]))).detail).toContain(
      'never claimed',
    );
    const refused = call('board_claim', { nodeIds: ['n_t'] }, 'Claimed by someone else', {
      isError: true,
    });
    expect((await run(claimedBeforeEditing({ key: 't' }), c([refused, edit]))).pass).toBe(false);
  });

  it('scores reading against the cost of reading everything', async () => {
    const reads = (tokens: number) => [
      call('board_outline', {}, '', { resultTokens: tokens }),
      call('board_apply', { ops }, '', { resultTokens: 5000 }),
    ];
    const check = targetedReads({ goodFraction: 0.1, badFraction: 0.5 });
    const cheap = await run(check, ctx(b, reads(50), { metrics: { fullReadTokens: 1000 } }));
    expect(cheap.score).toBe(1);
    const half = await run(check, ctx(b, reads(300), { metrics: { fullReadTokens: 1000 } }));
    expect(half.score).toBeCloseTo(0.5);
    expect(half.pass).toBe(false);
    const all = await run(check, ctx(b, reads(1000), { metrics: { fullReadTokens: 1000 } }));
    expect(all.score).toBe(0);
    expect((await run(check, ctx(b, reads(1)))).pass).toBe(false);
  });

  it('checks the budget in calls and tokens', async () => {
    const calls = [call('board_outline'), call('board_read')];
    expect(
      (await run(withinBudget({ maxToolCalls: 2, maxBoardTokens: 220 }), ctx(b, calls))).pass,
    ).toBe(true);
    const over = await run(withinBudget({ maxToolCalls: 1, maxBoardTokens: 100 }), ctx(b, calls));
    expect(over.pass).toBe(false);
    expect(over.detail).toBe('2 tool calls > 1; 220 board tokens > 100');
  });
});
