import { describe, expect, it } from 'vitest';
import {
  type AccessAction,
  AccessActionSchema,
  API_ACTIONS,
  can,
  forbiddenMessage,
  GrantAccessInputSchema,
  leastRoleFor,
  type Role,
  RoleSchema,
  TOKEN_PATTERN,
} from './access.js';
import { BOARD_API_ACTIONS, OpenBoardError } from './api.js';

/** The expected matrix, written out by hand. */
const MATRIX: Record<AccessAction, Record<Role, boolean>> = {
  'board.read': { owner: true, editor: true, commenter: true, viewer: true },
  presence: { owner: true, editor: true, commenter: true, viewer: true },
  'config.read': { owner: true, editor: true, commenter: true, viewer: true },
  comment: { owner: true, editor: true, commenter: true, viewer: false },
  'ask.create': { owner: true, editor: true, commenter: true, viewer: false },
  'ask.answer': { owner: true, editor: true, commenter: true, viewer: false },
  'board.create': { owner: true, editor: true, commenter: false, viewer: false },
  'board.edit': { owner: true, editor: true, commenter: false, viewer: false },
  'board.undo': { owner: true, editor: true, commenter: false, viewer: false },
  'proposal.decide': { owner: true, editor: true, commenter: false, viewer: false },
  'config.write': { owner: true, editor: false, commenter: false, viewer: false },
  'access.manage': { owner: true, editor: false, commenter: false, viewer: false },
};

describe('can', () => {
  it('covers every action', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...AccessActionSchema.options].sort());
  });

  for (const action of AccessActionSchema.options) {
    for (const role of RoleSchema.options) {
      it(`${role} ${MATRIX[action][role] ? 'may' : 'may not'} ${action}`, () => {
        expect(can(role, action)).toBe(MATRIX[action][role]);
      });
    }
  }

  it('gives every role at least what the role below it has', () => {
    const order: Role[] = ['viewer', 'commenter', 'editor', 'owner'];
    for (const action of AccessActionSchema.options) {
      for (let i = 1; i < order.length; i++) {
        if (can(order[i - 1] as Role, action)) expect(can(order[i] as Role, action)).toBe(true);
      }
    }
  });

  it('names the missing permission and the least role that has it', () => {
    expect(leastRoleFor('comment')).toBe('commenter');
    expect(leastRoleFor('access.manage')).toBe('owner');
    const message = forbiddenMessage('viewer', 'board.edit');
    expect(message).toContain('viewer');
    expect(message).toContain('"board.edit"');
    expect(message).toContain('editor');
  });
});

describe('API_ACTIONS', () => {
  it('is the table BoardApi is checked against', () => {
    expect(BOARD_API_ACTIONS).toBe(API_ACTIONS);
  });

  it('keeps writes away from viewers and access management with owners', () => {
    expect(can('viewer', API_ACTIONS.apply)).toBe(false);
    expect(can('commenter', API_ACTIONS.comment)).toBe(true);
    expect(can('commenter', API_ACTIONS.apply)).toBe(false);
    expect(can('editor', API_ACTIONS.grantAccess)).toBe(false);
    expect(API_ACTIONS.whoami).toBeNull();
  });
});

describe('GrantAccessInputSchema', () => {
  it('refuses an agent owner and unknown fields', () => {
    expect(
      GrantAccessInputSchema.safeParse({ label: 'Bot', role: 'owner', kind: 'agent' }).success,
    ).toBe(false);
    expect(
      GrantAccessInputSchema.safeParse({ label: 'Ada', role: 'owner', kind: 'human' }).success,
    ).toBe(true);
    expect(
      GrantAccessInputSchema.safeParse({
        label: 'Bot',
        role: 'editor',
        kind: 'agent',
        actorId: 'ada',
      }).success,
    ).toBe(false);
    expect(
      GrantAccessInputSchema.safeParse({ label: ' ', role: 'viewer', kind: 'human' }).success,
    ).toBe(false);
  });
});

describe('tokens and errors', () => {
  it('splits a token into grant id and secret', () => {
    const token = `ob_abcdefghij012345_${'A'.repeat(43)}`;
    expect(TOKEN_PATTERN.exec(token)?.[1]).toBe('abcdefghij012345');
    expect(TOKEN_PATTERN.test('ob_short_secret')).toBe(false);
  });

  it('maps unauthorized to 401 and rate_limited to 429', () => {
    expect(new OpenBoardError('unauthorized', 'x').status).toBe(401);
    expect(new OpenBoardError('rate_limited', 'x').status).toBe(429);
  });
});
