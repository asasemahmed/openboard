import { describe, expect, it } from 'vitest';
import {
  ActorSchema,
  ApplyRequestSchema,
  BoardSchema,
  NodeInputSchema,
  newId,
  OpSchema,
  slugify,
  ViewSchema,
} from './index.js';

const now = '2026-01-01T00:00:00.000Z';

describe('schema', () => {
  it('accepts a minimal board', () => {
    const board = BoardSchema.parse({
      schemaVersion: 1,
      id: 'main',
      name: 'Main',
      createdAt: now,
      updatedAt: now,
      actors: {},
      nodes: {},
      edges: {},
    });
    expect(board.id).toBe('main');
  });

  it('accepts built-in and namespaced custom node types only', () => {
    expect(NodeInputSchema.safeParse({ type: 'task', title: 'A' }).success).toBe(true);
    expect(NodeInputSchema.safeParse({ type: 'x:persona', title: 'A' }).success).toBe(true);
    expect(NodeInputSchema.safeParse({ type: 'persona', title: 'A' }).success).toBe(false);
  });

  it('rejects an empty title', () => {
    expect(NodeInputSchema.safeParse({ type: 'note', title: '' }).success).toBe(false);
  });
});

describe('ops', () => {
  it('lets a batch refer to nodes it creates', () => {
    const request = ApplyRequestSchema.parse({
      ops: [
        { op: 'add_node', ref: 'goal', node: { type: 'note', title: 'Goal' } },
        { op: 'add_node', ref: 'task', node: { type: 'task', title: 'Task', parent: '$goal' } },
        { op: 'add_edge', edge: { type: 'depends_on', source: '$task', target: '$goal' } },
      ],
    });
    expect(request.ops).toHaveLength(3);
  });

  it('rejects unknown operations', () => {
    expect(OpSchema.safeParse({ op: 'explode', id: 'n_1' }).success).toBe(false);
  });
});

describe('ids', () => {
  it('generates prefixed ids that pass the id schema', () => {
    const id = newId('n');
    expect(id).toMatch(/^n_[0-9a-z]{10}$/);
  });

  it('slugifies names', () => {
    expect(slugify('My Board!')).toBe('my-board');
    expect(slugify('***')).toBe('board');
    expect(slugify('Ünïcode Plan')).toBe('unicode-plan');
  });
});

describe('colors, which clients put into CSS', () => {
  it('are hex, a name or a number in stored actors and views, never url() or a declaration', () => {
    for (const color of ['#c2410c', '#FFF', '#11223344', 'red', '3']) {
      expect(ActorSchema.safeParse({ id: 'a', kind: 'agent', name: 'A', color }).success).toBe(
        true,
      );
      expect(ViewSchema.safeParse({ x: 0, y: 0, color }).success).toBe(true);
    }
    for (const color of ['url(//evil.example/p)', 'red;background:red', 'var(--x)', '#12']) {
      expect(ActorSchema.safeParse({ id: 'a', kind: 'agent', name: 'A', color }).success).toBe(
        false,
      );
      expect(ViewSchema.safeParse({ x: 0, y: 0, color }).success).toBe(false);
    }
  });
});
