/**
 * Presentation metadata for node types. Colours are CSS custom properties
 * (`--type-<tone>`) defined per theme in styles/tokens.css.
 */
import { BUILTIN_NODE_TYPES, type BuiltinNodeType, type Status } from '@openboard/core';

export interface TypeMeta {
  type: string;
  /** Human name, e.g. "Decision". */
  name: string;
  /** What the mono label on a card reads (rendered uppercase). */
  label: string;
  /** Suffix of the `--type-*` colour token. */
  tone: string;
  hint: string;
  /** Single-key shortcut that creates one, if any. */
  key?: string;
  /** Status a new node of this type starts with. */
  initialStatus?: Status;
}

const BUILTIN: Record<BuiltinNodeType, TypeMeta> = {
  note: {
    type: 'note',
    name: 'Note',
    label: 'note',
    tone: 'note',
    hint: 'A thought or fact',
    key: 'n',
  },
  task: {
    type: 'task',
    name: 'Task',
    label: 'task',
    tone: 'task',
    hint: 'Something to get done',
    key: 't',
    initialStatus: 'todo',
  },
  decision: {
    type: 'decision',
    name: 'Decision',
    label: 'decision',
    tone: 'decision',
    hint: 'A choice and why',
  },
  question: {
    type: 'question',
    name: 'Question',
    label: 'question',
    tone: 'question',
    hint: 'Something open',
  },
  risk: { type: 'risk', name: 'Risk', label: 'risk', tone: 'risk', hint: 'What could go wrong' },
  doc: { type: 'doc', name: 'Doc', label: 'doc', tone: 'doc', hint: 'Longer writing' },
  code: {
    type: 'code',
    name: 'Code',
    label: 'code',
    tone: 'code',
    hint: 'A file, symbol or change',
  },
  agent: { type: 'agent', name: 'Agent', label: 'agent', tone: 'agent', hint: 'An agent at work' },
  run: { type: 'run', name: 'Run', label: 'run', tone: 'run', hint: 'One execution of something' },
  frame: {
    type: 'frame',
    name: 'Frame',
    label: 'frame',
    tone: 'frame',
    hint: 'Groups other nodes',
    key: 'f',
  },
};

/** Types a card can be switched between (frames are containers, not cards). */
export const CARD_TYPES = BUILTIN_NODE_TYPES.filter((type) => type !== 'frame');

export const ADDABLE_TYPES: readonly BuiltinNodeType[] = BUILTIN_NODE_TYPES;

export function typeMeta(type: string): TypeMeta {
  if (type in BUILTIN) return BUILTIN[type as BuiltinNodeType];
  const name = type.startsWith('x:') ? type.slice(2) : type;
  return {
    type,
    name: name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, ' '),
    label: type,
    tone: 'custom',
    hint: 'Custom type',
  };
}

export const STATUS_META: Record<Status, { name: string; tone: string }> = {
  todo: { name: 'To do', tone: 'todo' },
  in_progress: { name: 'In progress', tone: 'progress' },
  blocked: { name: 'Blocked', tone: 'blocked' },
  done: { name: 'Done', tone: 'done' },
  cancelled: { name: 'Cancelled', tone: 'cancelled' },
};
