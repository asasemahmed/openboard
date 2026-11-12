import {
  type Ask,
  type Batch,
  DEFAULT_CONFIG,
  FRAME_POLICY_PROP,
  MENTION_AGENTS,
  type ProjectConfig,
} from '@openboard/core';
import { describe, expect, it } from 'vitest';
import { answerPayload, askedNodes, askOptions, openAsks } from './asks.js';
import { filterThreads, indexComments } from './comments.js';
import { historyRow, mergeBatches, replaceNewest, undoableBy, undoOutcome } from './historyRows.js';
import { insertMention, matchTargets, mentionQuery, mentionsIn } from './mentions.js';
import { placeControl, placeControls } from './overlay.js';
import {
  configFromForm,
  formChanged,
  frameAccess,
  framePolicyProps,
  policyForm,
} from './policy.js';

const ask = (over: Partial<Ask>): Ask => ({
  id: 'a_1',
  author: 'bot',
  kind: 'question',
  question: 'Which one?',
  status: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('asks', () => {
  it('stacks open questions oldest first', () => {
    const list = [
      ask({ id: 'a_3', createdAt: '2026-01-03T00:00:00.000Z' }),
      ask({ id: 'a_1', createdAt: '2026-01-01T00:00:00.000Z' }),
      ask({ id: 'a_2', status: 'answered' }),
      ask({ id: 'a_4', createdAt: '2026-01-02T00:00:00.000Z' }),
    ];
    expect(openAsks(list).map((a) => a.id)).toEqual(['a_1', 'a_4', 'a_3']);
    expect(
      askedNodes([ask({ nodeIds: ['n1', 'n2'] }), ask({ id: 'a_9', nodeIds: ['n1'] })]),
    ).toEqual(
      new Map([
        ['n1', ['a_1', 'a_9']],
        ['n2', ['a_1']],
      ]),
    );
  });

  it('labels options as given, with a primary button only for an approval', () => {
    expect(askOptions({ kind: 'question', options: ['Yes', 'No'] })).toEqual([
      { label: 'Yes', value: 'Yes', primary: false },
      { label: 'No', value: 'No', primary: false },
    ]);
    expect(askOptions({ kind: 'approval', options: ['Ship it', 'Wait'] })[0]).toMatchObject({
      label: 'Ship it',
      primary: true,
    });
    expect(askOptions({ kind: 'approval' }).map((o) => [o.label, o.primary])).toEqual([
      ['Approve', true],
      ['Decline', false],
    ]);
    expect(askOptions({ kind: 'question' })).toEqual([]);
  });

  it('sends an option, a text, or both', () => {
    expect(answerPayload('Yes', '')).toEqual({ option: 'Yes' });
    expect(answerPayload(undefined, '  later ')).toEqual({ text: 'later' });
    expect(answerPayload('Yes', 'but carefully')).toEqual({ option: 'Yes', text: 'but carefully' });
    expect(answerPayload(undefined, '   ')).toBeNull();
  });
});

describe('mentions', () => {
  it('finds the mention being typed', () => {
    expect(mentionQuery('Hi @pla', 7)).toEqual({ start: 3, query: 'pla' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('mail me@example.com', 19)).toBeNull();
    expect(mentionQuery('line\n@x\nnext', 12)).toBeNull();
    expect(mentionQuery('no mention', 10)).toBeNull();
  });

  it('inserts the picked name and keeps it while it is in the text', () => {
    const typed = 'Ask @pla about it';
    const next = insertMention(typed, 4, 8, 'Planner bot');
    expect(next.text).toBe('Ask @Planner bot about it');
    expect(next.caret).toBe('Ask @Planner bot '.length);
    const picked = [
      { id: 'planner', label: 'Planner bot' },
      { id: MENTION_AGENTS, label: 'All agents' },
    ];
    expect(mentionsIn(next.text, picked)).toEqual(['planner']);
    expect(mentionsIn(`${next.text} @All agents`, picked)).toEqual(['planner', MENTION_AGENTS]);
    expect(
      matchTargets(
        [
          { id: 'x', label: 'Ada' },
          { id: 'y', label: 'Grace' },
          { id: 'z', label: 'Sada' },
        ],
        'ad',
      ).map((t) => t.id),
    ).toEqual(['x', 'z']);
  });
});

describe('comment threads', () => {
  it('groups by thread, newest activity first, with open counts per node', () => {
    const c = (id: string, thread: string, at: string, more: object = {}) => ({
      id,
      thread,
      author: 'ada',
      body: id,
      createdAt: `2026-01-0${at}T00:00:00.000Z`,
      ...more,
    });
    const index = indexComments([
      c('c_1', 'c_1', '1', { nodeId: 'n1' }),
      c('c_2', 'c_1', '4', { nodeId: 'n1', author: 'bot' }),
      c('c_3', 'c_3', '2', { nodeId: 'n1', resolvedAt: '2026-01-05T00:00:00.000Z' }),
      c('c_4', 'c_4', '3', { mentions: ['me'], author: 'bot' }),
    ]);
    expect(index.threads.map((t) => t.id)).toEqual(['c_1', 'c_4', 'c_3']);
    expect(index.threads[0]?.comments.map((x) => x.id)).toEqual(['c_1', 'c_2']);
    expect(index.openByNode.get('n1')).toBe(1);
    expect(filterThreads(index.threads, 'resolved', 'me').map((t) => t.id)).toEqual(['c_3']);
    expect(filterThreads(index.threads, 'mine', 'me').map((t) => t.id)).toEqual(['c_4']);
  });
});

describe('history rows', () => {
  const batch = (over: Partial<Batch>): Batch => ({
    id: 'b_1',
    cursor: 1,
    at: '2026-01-01T00:00:00.000Z',
    actor: 'bot',
    source: 'ops',
    summary: 'Added 1 node',
    nodeIds: ['n1'],
    edgeIds: [],
    ...over,
  });

  it('badges and the undo or redo action', () => {
    expect(historyRow(batch({})).action).toEqual({ kind: 'undo', batchId: 'b_1' });
    const fromProposal = historyRow(batch({ proposalId: 'p_1' }));
    expect(fromProposal.badges).toEqual(['proposal']);
    const undone = historyRow(batch({ undoneBy: 'b_2' }));
    expect(undone.badges).toEqual(['undone']);
    expect(undone.action).toEqual({ kind: 'redo', batchId: 'b_2' });
    const undo = historyRow(batch({ id: 'b_2', source: 'undo', undoes: 'b_1' }));
    expect(undo.badges).toEqual(['undo']);
    expect(undo.action).toBeNull();
  });

  it('merges pages newest first and counts what an actor can still undo', () => {
    const merged = mergeBatches(
      [batch({ id: 'b_1', cursor: 1 }), batch({ id: 'b_2', cursor: 2 })],
      [
        batch({ id: 'b_2', cursor: 2, undoneBy: 'b_3' }),
        batch({ id: 'b_3', cursor: 3, source: 'undo' }),
      ],
    );
    expect(merged.map((b) => b.id)).toEqual(['b_3', 'b_2', 'b_1']);
    expect(merged[1]?.undoneBy).toBe('b_3');
    expect(undoableBy(merged, 'bot').map((b) => b.id)).toEqual(['b_1']);
  });

  it('replaces the rows it re-read and keeps older pages', () => {
    const shown = [3, 2, 1].map((n) => batch({ id: `b_${n}`, cursor: n }));
    const fresh = [
      batch({ id: 'b_4', cursor: 4 }),
      batch({ id: 'b_3', cursor: 3, undoneBy: 'b_4' }),
    ];
    const next = replaceNewest(shown, fresh, false);
    expect(next.map((b) => [b.id, b.undoneBy ?? null])).toEqual([
      ['b_4', null],
      ['b_3', 'b_4'],
      ['b_2', null],
      ['b_1', null],
    ]);
    // A complete read drops rows that no longer exist (pruned history).
    expect(replaceNewest(shown, fresh, true).map((b) => b.id)).toEqual(['b_4', 'b_3']);
  });

  it('says plainly what an undo left alone', () => {
    expect(undoOutcome({ undone: ['b_1'], conflicts: [] })).toBe('Undone.');
    const two = [
      { kind: 'node' as const, id: 'n1', reason: 'x' },
      { kind: 'node' as const, id: 'n2', reason: 'y' },
    ];
    expect(undoOutcome({ undone: ['b_1'], conflicts: two })).toBe(
      'Undone. Left 2 items as they are because they were changed afterwards.',
    );
    expect(undoOutcome({ undone: [], conflicts: two.slice(0, 1) })).toBe(
      'Nothing was changed. Left 1 item as it is because it was changed afterwards.',
    );
    expect(undoOutcome({ undone: ['b_1', 'b_2'], conflicts: [] }, 'Redone')).toBe(
      'Redone 2 changes.',
    );
  });
});

describe('policy', () => {
  const base: ProjectConfig = {
    version: 1,
    policy: { default: 'review_destructive', agents: { other: 'locked', bot: 'auto' } },
  };

  it('turns a config into a form and back, keeping agents not shown', () => {
    const form = policyForm(base, [{ id: 'bot' }, { id: 'new' }]);
    expect(form).toEqual({
      default: 'review_destructive',
      agents: { bot: 'auto', new: 'default' },
    });
    expect(formChanged(form, base)).toBe(false);
    const edited = {
      default: 'review_all' as const,
      agents: { bot: 'default' as const, new: 'locked' as const },
    };
    expect(configFromForm(edited, base)).toEqual({
      version: 1,
      policy: { default: 'review_all', agents: { other: 'locked', new: 'locked' } },
    });
    expect(formChanged(edited, base)).toBe(true);
    expect(policyForm(DEFAULT_CONFIG, []).agents).toEqual({});
  });

  it('reads and writes a frame override without touching other props', () => {
    const frame = { type: 'frame', props: { owner: 'ada', [FRAME_POLICY_PROP]: 'review' } };
    expect(frameAccess(frame)).toBe('review');
    expect(frameAccess({ type: 'note', props: { [FRAME_POLICY_PROP]: 'locked' } })).toBe('inherit');
    expect(framePolicyProps(frame, 'locked')).toEqual({
      owner: 'ada',
      [FRAME_POLICY_PROP]: 'locked',
    });
    expect(framePolicyProps(frame, 'inherit')).toEqual({ owner: 'ada' });
    expect(framePolicyProps({ props: { [FRAME_POLICY_PROP]: 'auto' } }, 'inherit')).toBeNull();
    expect(framePolicyProps({}, 'auto')).toEqual({ [FRAME_POLICY_PROP]: 'auto' });
  });
});

describe('placeControl', () => {
  const view = { w: 1000, h: 800 };
  const size = { w: 300, h: 90 };
  it('goes below the target, above when there is no room, and stays in view', () => {
    expect(placeControl({ x: 100, y: 100, w: 200, h: 200 }, view, size)).toEqual({
      left: 100,
      top: 310,
    });
    expect(placeControl({ x: 100, y: 600, w: 200, h: 180 }, view, size)).toEqual({
      left: 100,
      top: 476,
    });
    expect(placeControl({ x: 900, y: -50, w: 400, h: 100 }, view, size)).toEqual({
      left: 692,
      top: 60,
    });
    expect(placeControl({ x: 1200, y: 100, w: 100, h: 100 }, view, size)).toBeNull();
  });
});

describe('placeControls', () => {
  it('moves a control down past one it would cover', () => {
    const view = { w: 1000, h: 800 };
    const size = { w: 300, h: 90 };
    const spots = placeControls(
      [
        { x: 100, y: 100, w: 200, h: 100 },
        { x: 150, y: 100, w: 200, h: 100 },
        { x: 600, y: 100, w: 200, h: 100 },
      ],
      view,
      size,
    );
    expect(spots).toEqual([
      { left: 100, top: 210 },
      { left: 150, top: 308 },
      { left: 600, top: 210 },
    ]);
  });
});
