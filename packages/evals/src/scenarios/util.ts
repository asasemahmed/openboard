/** Op builders that keep scenario fixtures short. */
import type { Op, Status } from '@openboard/core';

export function frame(ref: string, title: string, parent?: string): Op {
  return { op: 'add_node', ref, node: { type: 'frame', title, ...(parent ? { parent } : {}) } };
}

export function node(
  ref: string,
  type: string,
  title: string,
  extra: {
    parent?: string;
    status?: Status;
    body?: string;
    links?: Array<{ kind: 'file'; target: string; line?: number; endLine?: number }>;
  } = {},
): Op {
  return { op: 'add_node', ref, node: { type, title, ...extra } } as Op;
}

export function task(
  ref: string,
  title: string,
  parent: string,
  status: Status = 'todo',
  body?: string,
): Op {
  return node(ref, 'task', title, { parent, status, ...(body ? { body } : {}) });
}

export function edge(type: string, source: string, target: string): Op {
  return { op: 'add_edge', edge: { type, source, target } };
}

/** Keep the refs of a setup batch whose keys are listed, under the same names. */
export function keep(
  ids: Record<string, string>,
  refs: Record<string, string>,
  keys: string[],
): void {
  for (const key of keys) {
    const id = refs[key];
    if (!id) throw new Error(`setup did not create ${key}`);
    ids[key] = id;
  }
}
