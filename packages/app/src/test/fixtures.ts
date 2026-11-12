import { type Actor, BoardDoc, type Op } from '@openboard/core';
import { vi } from 'vitest';
import type { ApiClient } from '../lib/api.js';

export const ME: Actor = { id: 'a_me0000001', kind: 'human', name: 'Ada', color: '#1D5FBF' };
export const AGENT: Actor = { id: 'a_agent00001', kind: 'agent', name: 'planner' };

/** A small board: a frame with a nested frame, cards inside and outside, two edges. */
export function sampleDoc(): BoardDoc {
  const doc = BoardDoc.create({ id: 'test-board', name: 'Checkout' });
  const ops: Op[] = [
    {
      op: 'add_node',
      id: 'outer',
      node: { type: 'frame', title: 'Release', view: { x: 100, y: 100, w: 800, h: 600 } },
    },
    {
      op: 'add_node',
      id: 'inner',
      node: {
        type: 'frame',
        title: 'API',
        parent: 'outer',
        view: { x: 40, y: 60, w: 400, h: 300 },
      },
    },
    {
      op: 'add_node',
      id: 'task1',
      node: {
        type: 'task',
        title: 'Payment API',
        status: 'done',
        parent: 'inner',
        view: { x: 32, y: 56 },
      },
    },
    {
      op: 'add_node',
      id: 'risk1',
      node: {
        type: 'risk',
        title: 'Double charge on retry',
        body: 'If the **gateway** times out we may [retry](https://example.com) twice.',
        status: 'in_progress',
        tags: ['payments', 'p1', 'retry'],
        view: { x: 1000, y: 100 },
      },
    },
    {
      op: 'add_node',
      id: 'note1',
      node: { type: 'note', title: 'Loose note', view: { x: 0, y: 0 } },
    },
    { op: 'add_edge', id: 'e1', edge: { type: 'blocks', source: 'risk1', target: 'task1' } },
    { op: 'add_edge', id: 'e2', edge: { type: 'relates_to', source: 'note1', target: 'risk1' } },
  ];
  const outcome = doc.apply(ops, { actor: AGENT });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.errors));
  return doc;
}

/** An API client whose every call is a mock; pass overrides for the calls a test uses. */
export function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listBoards: vi.fn(async () => []),
    createBoard: vi.fn(),
    layout: vi.fn(),
    changes: vi.fn(async (boardId: string) => ({
      boardId,
      since: 0,
      cursor: 0,
      changes: [],
      resync: false,
      text: '',
      tokens: 0,
      truncated: false,
    })),
    info: vi.fn(async () => null),
    ...overrides,
  };
}
