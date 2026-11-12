import type { ApplyResult, TemplateSummary } from '@openboard/core';
import { describe, expect, it } from 'vitest';
import {
  initialTemplate,
  starters,
  templateCounts,
  templateReducer,
  templateRequest,
} from './templateFlow.js';

const T = (id: string, extra: Partial<TemplateSummary> = {}): TemplateSummary => ({
  id,
  name: id,
  description: '',
  tags: [],
  source: 'builtin',
  nodeCount: 4,
  edgeCount: 2,
  ...extra,
});

const applied = (nodes: string[], edges: string[] = []): ApplyResult => ({
  status: 'applied',
  cursor: 1,
  refs: {},
  applied: {
    refs: {},
    addedNodes: nodes,
    updatedNodes: [],
    removedNodes: [],
    addedEdges: edges,
    updatedEdges: [],
    removedEdges: [],
  },
});

describe('insert template flow', () => {
  it('goes list → choose → dry run → apply → result', () => {
    let s = initialTemplate('f1');
    expect(s.step).toBe('loading');
    s = templateReducer(s, { type: 'loaded', templates: [T('kanban'), T('feature-plan')] });
    expect(s.step).toBe('choose');
    // Nothing chosen yet: checking does nothing.
    expect(templateReducer(s, { type: 'check' }).step).toBe('choose');
    s = templateReducer(s, { type: 'choose', id: 'kanban' });
    s = templateReducer(s, { type: 'title', title: '  Sprint 4  ' });
    expect(templateRequest(s, true)).toEqual({
      template: 'kanban',
      dryRun: true,
      title: 'Sprint 4',
      frame: 'f1',
    });
    s = templateReducer(s, { type: 'check' });
    expect(s.step).toBe('checking');
    s = templateReducer(s, {
      type: 'checked',
      result: { ...applied(['a', 'b', 'c'], ['e']), status: 'valid' },
    });
    expect(s.step).toBe('preview');
    expect(s.preview).toEqual({ nodes: 3, edges: 1, review: null });
    s = templateReducer(s, { type: 'apply' });
    expect(s.step).toBe('applying');
    s = templateReducer(s, { type: 'applied', result: applied(['n1', 'n2', 'n3']) });
    expect(s.step).toBe('done');
    expect(s.result).toEqual({ nodeIds: ['n1', 'n2', 'n3'], proposed: false });
  });

  it('says when it will wait for review, and when it was sent for review', () => {
    let s = templateReducer(initialTemplate(), { type: 'loaded', templates: [T('kanban')] });
    s = templateReducer(templateReducer(s, { type: 'choose', id: 'kanban' }), { type: 'check' });
    s = templateReducer(s, {
      type: 'checked',
      result: {
        ...applied(['a']),
        status: 'valid',
        review: { indexes: [0], why: 'agents propose' },
      },
    });
    expect(s.preview?.review).toBe('agents propose');
    s = templateReducer(templateReducer(s, { type: 'apply' }), {
      type: 'applied',
      result: { status: 'proposed', cursor: 2, refs: { a: 'n9' }, proposalId: 'p1' },
    });
    expect(s.result).toEqual({ nodeIds: ['n9'], proposed: true });
  });

  it('keeps refusals and failures next to the controls', () => {
    let s = templateReducer(initialTemplate(), { type: 'loaded', templates: [T('kanban')] });
    s = templateReducer(templateReducer(s, { type: 'choose', id: 'kanban' }), { type: 'check' });
    s = templateReducer(s, {
      type: 'checked',
      result: {
        status: 'invalid',
        cursor: 1,
        refs: {},
        errors: [{ index: 0, code: 'invalid', message: 'frame is locked' }],
      },
    });
    expect(s.step).toBe('choose');
    expect(s.error).toBe('frame is locked');
    // Changing anything clears it.
    expect(templateReducer(s, { type: 'frame', frame: null }).error).toBeNull();

    s = templateReducer(templateReducer(s, { type: 'check' }), {
      type: 'checked',
      result: { ...applied(['a']), status: 'valid' },
    });
    s = templateReducer(templateReducer(s, { type: 'apply' }), {
      type: 'failed',
      message: 'The server is not reachable right now.',
    });
    expect(s.step).toBe('preview');
    expect(s.error).toMatch(/not reachable/);

    const unloaded = templateReducer(initialTemplate(), { type: 'failed', message: 'nope' });
    expect(unloaded).toMatchObject({ step: 'choose', error: 'nope' });
  });

  it('offers the three most useful templates on an empty board', () => {
    const all = [T('agent-team'), T('kanban'), T('research-map'), T('feature-plan')];
    expect(starters(all).map((t) => t.id)).toEqual(['feature-plan', 'kanban', 'agent-team']);
    expect(starters([T('only')]).map((t) => t.id)).toEqual(['only']);
    expect(templateCounts(T('x', { nodeCount: 1, edgeCount: 0 }))).toBe('1 node');
    expect(templateCounts(T('x'))).toBe('4 nodes, 2 connections');
  });
});
