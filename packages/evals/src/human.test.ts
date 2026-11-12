import type { Ask, Board, BoardApi, Decision, Proposal } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { describeScript, HumanEngine } from './human.js';
import type { HumanScript, ToolCallRecord } from './types.js';

const AT = '2026-11-12T00:00:00.000Z';

/** Just enough of a BoardApi to watch what the person does. */
function fakeApi() {
  const calls: string[] = [];
  const proposals: Proposal[] = [];
  const asks: Ask[] = [];
  const board = {
    id: 'main',
    nodes: { n_a: { id: 'n_a', type: 'task', title: 'Alpha' } },
    edges: {},
    actors: {},
  } as unknown as Board;
  const api = {
    proposals: async () => ({ proposals: proposals.filter((p) => p.status === 'pending') }),
    asks: async () => ({ asks: asks.filter((a) => a.status === 'open') }),
    askResult: async (_b: string, id: string) => asks.find((a) => a.id === id),
    getBoard: async () => board,
    decideProposal: async (_b: string, id: string, decision: Decision) => {
      calls.push(`decide ${id} ${decision.action}${decision.note ? ` ${decision.note}` : ''}`);
      const p = proposals.find((x) => x.id === id);
      if (p) p.status = decision.action === 'accept' ? 'accepted' : 'rejected';
      return p;
    },
    answerAsk: async (_b: string, id: string, answer: { text?: string }) => {
      calls.push(`answer ${id} ${answer.text}`);
      const a = asks.find((x) => x.id === id);
      if (a) a.status = 'answered';
      return a;
    },
    apply: async (_b: string, request: { ops: unknown[] }) => {
      calls.push(`apply ${JSON.stringify(request.ops)}`);
      return { status: 'applied' };
    },
    comment: async (_b: string, input: { body: string; nodeId?: string }) => {
      calls.push(`comment ${input.nodeId ?? 'board'} ${input.body}`);
      return {};
    },
  } as unknown as BoardApi;
  const propose = (id: string, addsFrame = false) =>
    proposals.push({
      id,
      author: 'eval-agent',
      createdAt: AT,
      status: 'pending',
      items: [
        {
          index: 0,
          op: { op: 'add_node', node: { type: addsFrame ? 'frame' : 'task', title: 'X' } },
          status: 'pending',
          needsReview: true,
          dependsOn: [],
          summary: '',
        },
      ],
      preview: { nodes: {}, edges: {}, updated: {}, removedNodes: [], removedEdges: [] },
    } as Proposal);
  const askQuestion = (id: string) =>
    asks.push({
      id,
      author: 'eval-agent',
      kind: 'question',
      question: 'Which?',
      status: 'open',
      createdAt: AT,
    });
  return { api, calls, propose, askQuestion };
}

function record(tool: string, seq: number): ToolCallRecord {
  return {
    seq,
    connection: 1,
    tool,
    args: {},
    text: '',
    isError: false,
    startedMs: 0,
    durationMs: 0,
    argsTokens: 0,
    resultTokens: 0,
  };
}

function engine(
  script: HumanScript,
  extra: { delayScale?: number; publish?: (ids: string[]) => Promise<void> } = {},
) {
  const fake = fakeApi();
  let now = 0;
  const human = new HumanEngine(script, {
    api: fake.api,
    board: 'main',
    ids: { alpha: 'n_a' },
    now: () => now,
    ...(extra.delayScale !== undefined ? { delayScale: extra.delayScale } : {}),
    ...(extra.publish ? { publishSelection: extra.publish } : {}),
  });
  return {
    human,
    ...fake,
    at: (ms: number) => {
      now = ms;
    },
  };
}

describe('the simulated person', () => {
  it('reviews each proposal once, after the delay', async () => {
    const t = engine({ proposals: { decide: 'accept', note: 'Fine.', delayMs: 3000 } });
    t.propose('p_1');
    await t.human.tick();
    expect(t.calls).toEqual([]);
    expect(t.human.busy()).toBe(true);
    t.at(2999);
    await t.human.tick();
    expect(t.calls).toEqual([]);
    t.at(3000);
    await t.human.tick();
    expect(t.calls).toEqual(['decide p_1 accept Fine.']);
    expect(t.human.busy()).toBe(false);
    t.at(9000);
    await t.human.tick();
    expect(t.calls).toHaveLength(1);
    expect(t.human.log.map((l) => l.what)).toEqual(['accepted proposal p_1 with the note "Fine."']);
  });

  it('decides by a rule, and scales delays', async () => {
    const t = engine(
      {
        proposals: {
          decide: (p) =>
            p.items.some((i) => i.op.op === 'add_node' && i.op.node.type === 'frame')
              ? { action: 'reject', note: 'No new frames.' }
              : { action: 'accept' },
          delayMs: 1000,
        },
      },
      { delayScale: 0.1 },
    );
    t.propose('p_frame', true);
    await t.human.tick();
    t.at(100);
    await t.human.tick();
    t.propose('p_task');
    await t.human.tick();
    t.at(200);
    await t.human.tick();
    expect(t.calls).toEqual(['decide p_frame reject No new frames.', 'decide p_task accept']);
  });

  it('answers questions', async () => {
    const t = engine({ asks: { answer: { text: 'Only the done ones.' }, delayMs: 500 } });
    t.askQuestion('a_1');
    await t.human.tick();
    t.at(500);
    await t.human.tick();
    expect(t.calls).toEqual(['answer a_1 Only the done ones.']);
  });

  it('fires events after the n-th matching call, and holds calls until they are done', async () => {
    const t = engine({
      events: [
        {
          name: 'edit',
          at: { afterCalls: 2, tools: ['board_read'] },
          action: { kind: 'edit', node: { key: 'alpha' }, patch: { status: 'done' } },
        },
        {
          name: 'comment',
          at: { afterCalls: 1 },
          action: { kind: 'comment', on: { title: 'Alpha' }, body: 'Hi @agent' },
        },
      ],
    });
    t.human.onCall(record('board_read', 1));
    await t.human.gate();
    expect(t.calls).toEqual(['comment n_a Hi @agent']);
    t.human.onCall(record('board_outline', 2));
    await t.human.gate();
    expect(t.calls).toHaveLength(1);
    t.human.onCall(record('board_read', 3));
    expect(t.human.busy()).toBe(true);
    await t.human.gate();
    expect(t.calls[1]).toBe('apply [{"op":"update_node","id":"n_a","patch":{"status":"done"}}]');
    t.human.onCall(record('board_read', 4));
    await t.human.gate();
    expect(t.calls).toHaveLength(2);
  });

  it('fires timed events and publishes selections', async () => {
    const selected: string[][] = [];
    const t = engine(
      {
        events: [
          {
            name: 'select',
            at: { afterMs: 1000 },
            action: { kind: 'select', nodes: [{ id: 'n_a' }] },
          },
        ],
      },
      { publish: async (ids) => void selected.push(ids) },
    );
    await t.human.tick();
    expect(selected).toEqual([]);
    t.at(1000);
    await t.human.tick();
    expect(selected).toEqual([['n_a']]);
  });

  it('records a failing action instead of throwing', async () => {
    const t = engine({
      events: [
        {
          name: 'bad',
          at: { afterCalls: 1 },
          action: { kind: 'edit', node: { title: 'Nope' }, patch: {} },
        },
      ],
    });
    t.human.onCall(record('board_read', 1));
    await t.human.gate();
    expect(t.human.errors).toEqual(['bad failed: no node for {"title":"Nope"}']);
  });

  it('describes itself', () => {
    expect(
      describeScript({
        select: [{ key: 'alpha' }],
        proposals: { decide: 'accept', delayMs: 3000 },
        asks: { answer: { text: 'Yes' } },
        events: [
          {
            name: 'x',
            at: { afterCalls: 1, tools: ['board_read'] },
            action: { kind: 'edit', node: { key: 'a' }, patch: { status: 'done' } },
          },
        ],
      }),
    ).toEqual([
      'Before the run, selects {"key":"alpha"}.',
      'Accepts every proposal after 3000 ms.',
      'Answers every question with {"text":"Yes"} after 0 ms.',
      'After call 1 of board_read: edits {"key":"a"}: {"status":"done"}.',
    ]);
  });
});
