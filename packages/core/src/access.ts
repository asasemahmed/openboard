/**
 * Access control for shared mode (see "Shared mode" in docs/ARCHITECTURE.md).
 *
 * A server in shared mode lets people and agents on other machines in with an
 * access grant. Each grant has a role, and `can(role, action)` is the whole
 * rule set for what a role may attempt, as a pure table. The review policy
 * (collab.ts) still decides what an agent's change needs on top of that: the
 * role caps what it may try, the policy decides what needs review.
 */
import { z } from 'zod';
import { type Actor, IdSchema } from './schema.js';

// ── Roles and actions ────────────────────────────────────────────────────────

export const RoleSchema = z.enum(['owner', 'editor', 'commenter', 'viewer']);
export type Role = z.infer<typeof RoleSchema>;

/** Roles an agent grant may have. Agents never manage access or settings. */
export const AGENT_ROLES: readonly Role[] = ['editor', 'commenter', 'viewer'];

/** What a caller may attempt. Every route and `BoardApi` method needs exactly one. */
export const AccessActionSchema = z.enum([
  /** Read boards, history, proposals, questions, the inbox, sessions, code links, git. */
  'board.read',
  /** Create a board. */
  'board.create',
  /** Change boards: apply, layout, import, refresh links, claims, withdraw a proposal, sync writes. */
  'board.edit',
  /** Undo batches. */
  'board.undo',
  /** Accept or reject proposals (people only on top of this). */
  'proposal.decide',
  /** Comment, reply, resolve threads. */
  'comment',
  /** Ask a question, or cancel one. */
  'ask.create',
  /** Answer a question (people only on top of this). */
  'ask.answer',
  /** Presence and activity reports. */
  'presence',
  /** Read the project settings (review policy). */
  'config.read',
  /** Change the project settings (people only on top of this). */
  'config.write',
  /** List, create and revoke access grants (people only on top of this). */
  'access.manage',
]);
export type AccessAction = z.infer<typeof AccessActionSchema>;

const READ: readonly AccessAction[] = ['board.read', 'presence', 'config.read'];
const COMMENT: readonly AccessAction[] = [...READ, 'comment', 'ask.create', 'ask.answer'];
const EDIT: readonly AccessAction[] = [
  ...COMMENT,
  'board.create',
  'board.edit',
  'board.undo',
  'proposal.decide',
];

/** The whole table: which actions each role may attempt. */
export const ROLE_ACTIONS: Readonly<Record<Role, ReadonlySet<AccessAction>>> = {
  owner: new Set(AccessActionSchema.options),
  editor: new Set(EDIT),
  commenter: new Set(COMMENT),
  viewer: new Set(READ),
};

/** Whether `role` may attempt `action`. */
export function can(role: Role, action: AccessAction): boolean {
  return ROLE_ACTIONS[role].has(action);
}

const ACTION_TEXT: Record<AccessAction, string> = {
  'board.read': 'read boards',
  'board.create': 'create boards',
  'board.edit': 'change boards',
  'board.undo': 'undo changes',
  'proposal.decide': 'decide on proposals',
  comment: 'comment',
  'ask.create': 'ask questions',
  'ask.answer': 'answer questions',
  presence: 'report presence',
  'config.read': 'read the project settings',
  'config.write': 'change the project settings',
  'access.manage': 'manage access',
};

/** The least role that may attempt `action`. */
export function leastRoleFor(action: AccessAction): Role {
  for (const role of ['viewer', 'commenter', 'editor'] as const) if (can(role, action)) return role;
  return 'owner';
}

/** The `forbidden` message for a role that lacks an action; names the missing permission. */
export function forbiddenMessage(role: Role, action: AccessAction): string {
  return `your access (${role}) does not include "${action}" (${ACTION_TEXT[action]}); it needs ${leastRoleFor(action)} access or more, which an owner can grant`;
}

/**
 * The permission each `BoardApi` method needs. `null`: any caller with valid
 * credentials (`whoami`). The HTTP routes use the same table, so a route and
 * the method behind it can never disagree.
 */
export const API_ACTIONS = {
  listBoards: 'board.read',
  createBoard: 'board.create',
  getBoard: 'board.read',
  outline: 'board.read',
  read: 'board.read',
  changes: 'board.read',
  apply: 'board.edit',
  selection: 'board.read',
  layout: 'board.edit',
  proposals: 'board.read',
  decideProposal: 'proposal.decide',
  withdrawProposal: 'board.edit',
  history: 'board.read',
  undo: 'board.undo',
  comment: 'comment',
  resolveThread: 'comment',
  inbox: 'board.read',
  ask: 'ask.create',
  asks: 'board.read',
  askResult: 'board.read',
  answerAsk: 'ask.answer',
  cancelAsk: 'ask.create',
  reportActivity: 'presence',
  sessions: 'board.read',
  claim: 'board.edit',
  snapshotAt: 'board.read',
  links: 'board.read',
  refreshLinks: 'board.edit',
  revisions: 'board.read',
  boardAtRevision: 'board.read',
  diffRevisions: 'board.read',
  importInto: 'board.edit',
  exportBoard: 'board.read',
  schema: 'board.read',
  templates: 'board.read',
  applyTemplate: 'board.edit',
  getConfig: 'config.read',
  setConfig: 'config.write',
  whoami: null,
  listAccess: 'access.manage',
  grantAccess: 'access.manage',
  revokeAccess: 'access.manage',
} as const satisfies Record<string, AccessAction | null>;
export type ApiMethod = keyof typeof API_ACTIONS;

// ── Grants ───────────────────────────────────────────────────────────────────

/** How a caller proved who it is. `local`: loopback, trusted as the owner without credentials. */
export const AccessViaSchema = z.enum(['local', 'token', 'session']);
export type AccessVia = z.infer<typeof AccessViaSchema>;

/** Grant ids are 16 lowercase letters and digits, so `ob_<id>_<secret>` splits without doubt. */
export const GrantIdSchema = z.string().regex(/^[a-z0-9]{16}$/, 'invalid grant id');

/** Longest a grant may last: one year. */
export const MAX_GRANT_HOURS = 24 * 366;

/** A grant as the owner sees it. The secret is never part of it. */
export const AccessGrantSchema = z.object({
  id: GrantIdSchema,
  /** Who it is for, such as "Ada's laptop" or "CI agent". Also the default display name. */
  label: z.string().min(1).max(80),
  role: RoleSchema,
  kind: z.enum(['human', 'agent']),
  /** The actor everything done with this grant is attributed to. */
  actorId: IdSchema,
  createdAt: z.string(),
  /** Actor id of the owner who made it. */
  createdBy: IdSchema,
  expiresAt: z.string().optional(),
  revokedAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
});
export type AccessGrant = z.infer<typeof AccessGrantSchema>;

/** A grant as stored in `.openboard/.local/access.json`: the public fields plus the secret's hash. */
export const StoredGrantSchema = AccessGrantSchema.extend({
  /** Hex SHA-256 of the secret part of the token. */
  secretHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type StoredGrant = z.infer<typeof StoredGrantSchema>;

export const GrantAccessInputSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    role: RoleSchema,
    kind: z.enum(['human', 'agent']),
    /** Hours until the grant expires; it never expires when omitted. */
    expiresInHours: z.number().positive().max(MAX_GRANT_HOURS).optional(),
  })
  .strict()
  .refine((input) => input.kind === 'human' || AGENT_ROLES.includes(input.role), {
    message: 'an agent grant may be editor, commenter or viewer, not owner',
    path: ['role'],
  });
export type GrantAccessInput = z.infer<typeof GrantAccessInputSchema>;

export interface GrantAccessResult {
  grant: AccessGrant;
  /** `ob_<grant id>_<secret>`. Shown exactly once: only its hash is kept. */
  token: string;
  /** For a person: `<public url>/join#<token>`, the link to send them. */
  inviteUrl?: string;
}

export interface AccessList {
  grants: AccessGrant[];
}

/** Who the server takes the caller to be. */
export interface WhoAmI {
  actor: Actor;
  role: Role;
  /** Whether the server runs in shared mode. */
  shared: boolean;
  via: AccessVia;
  /** The grant behind a `token` or `session` caller. */
  grantId?: string;
  /** When that grant expires, if it does. */
  expiresAt?: string;
}

/** Matches a token: `ob_`, the grant id, `_`, at least 32 bytes of base64url. */
export const TOKEN_PATTERN = /^ob_([a-z0-9]{16})_([A-Za-z0-9_-]{43,128})$/;
