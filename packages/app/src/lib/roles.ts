/** Roles in words people read: one table for the share dialog, the join page and disabled controls. */
import { type AccessAction, leastRoleFor, type Role } from '@openboard/core';

export const ROLE_TEXT: Record<Role, { name: string; line: string; you: string }> = {
  owner: {
    name: 'Owner',
    line: 'Everything, including who has access and the review policy.',
    you: 'You can change everything, including who has access.',
  },
  editor: {
    name: 'Editor',
    line: 'Changes boards, decides on proposals, comments and undoes.',
    you: 'You can change boards, decide on agents’ proposals and comment.',
  },
  commenter: {
    name: 'Commenter',
    line: 'Reads boards, comments and answers agents’ questions.',
    you: 'You can view boards, comment and answer agents’ questions.',
  },
  viewer: {
    name: 'Viewer',
    line: 'Reads boards, follows changes, exports and replays.',
    you: 'You can view boards, follow changes, export and replay them.',
  },
};

export const PERSON_ROLES: readonly Role[] = ['viewer', 'commenter', 'editor', 'owner'];
export const AGENT_GRANT_ROLES: readonly Role[] = ['viewer', 'commenter', 'editor'];

const WHAT: Record<AccessAction, string> = {
  'board.read': 'read boards',
  'board.create': 'create boards',
  'board.edit': 'change this board',
  'board.undo': 'undo changes',
  'proposal.decide': 'decide on proposals',
  comment: 'comment',
  'ask.create': 'ask or dismiss questions',
  'ask.answer': 'answer questions',
  presence: 'show presence',
  'config.read': 'read the settings',
  'config.write': 'change the project settings',
  'access.manage': 'manage access',
};

/** Why a control is off: "Your access (viewer) does not let you change this board. Editors can." */
export function disabledReason(role: Role, action: AccessAction): string {
  const least = leastRoleFor(action);
  const who = least === 'owner' ? 'Owners' : `${ROLE_TEXT[least].name}s and owners`;
  return `Your access (${ROLE_TEXT[role].name.toLowerCase()}) does not let you ${WHAT[action]}. ${who} can.`;
}

/** The capability groups of the interface, for tests and for the shortcuts guard. */
export const CONTROL_GROUPS = {
  editCanvas: 'board.edit',
  addNodes: 'board.edit',
  tidy: 'board.edit',
  importInto: 'board.edit',
  inspectorEdit: 'board.edit',
  claimRelease: 'board.edit',
  refreshLinks: 'board.edit',
  undo: 'board.undo',
  decideProposals: 'proposal.decide',
  comment: 'comment',
  answerQuestions: 'ask.answer',
  dismissQuestions: 'ask.create',
  policySettings: 'config.write',
  share: 'access.manage',
  newBoard: 'board.create',
  readAndExport: 'board.read',
} as const satisfies Record<string, AccessAction>;
