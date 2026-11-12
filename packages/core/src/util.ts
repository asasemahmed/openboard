/**
 * Small internal helpers shared by the modules of this package. Not exported
 * from the package entry point.
 */
import type { z } from 'zod';
import type { BoardEdge, BoardNode } from './schema.js';

/** Fields every node and edge carries for attribution. */
export const BOOKKEEPING_FIELDS: ReadonlySet<string> = new Set([
  'createdBy',
  'createdAt',
  'updatedBy',
  'updatedAt',
]);

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural equality for JSON-like values. A key holding `undefined` counts
 * as absent, matching how the values serialize.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keysA = definedKeys(a);
  const keysB = definedKeys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!(key in b) || !jsonEqual(a[key], b[key])) return false;
  }
  return true;
}

function definedKeys(value: Plain): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

/** Names of the top-level fields whose values differ between two records. */
export function changedFields(before: object, after: object): string[] {
  const a = before as Plain;
  const b = after as Plain;
  const keys = new Set([...definedKeys(a), ...definedKeys(b)]);
  const out: string[] = [];
  for (const key of keys) if (!jsonEqual(a[key], b[key])) out.push(key);
  return out.sort(compareStrings);
}

/** Locale-independent string order (by UTF-16 code unit). */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deep copy of a JSON-like value. */
export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

/** Freeze a value and everything reachable from it. Returns the value. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Drop optional fields that carry no information (empty body, tag list, link
 * list or props), so that "absent" has exactly one representation.
 */
export function normalizeNode(node: BoardNode): BoardNode {
  if (
    node.body !== '' &&
    node.tags?.length !== 0 &&
    node.links?.length !== 0 &&
    (node.props === undefined || Object.keys(node.props).length > 0)
  ) {
    return node;
  }
  const out = { ...node };
  if (out.body === '') delete out.body;
  if (out.tags?.length === 0) delete out.tags;
  if (out.links?.length === 0) delete out.links;
  if (out.props !== undefined && Object.keys(out.props).length === 0) delete out.props;
  return out;
}

/** Edge counterpart of {@link normalizeNode}: an empty label is no label. */
export function normalizeEdge(edge: BoardEdge): BoardEdge {
  if (edge.label !== '') return edge;
  const out = { ...edge };
  delete out.label;
  return out;
}

/** Render a property path the way people write it: `nodes.n_1.tags[2]`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

/** One line per issue, at most `limit` of them, each naming the failing path. */
export function formatIssues(error: z.ZodError, prefix: readonly PropertyKey[] = [], limit = 3) {
  const lines = error.issues.slice(0, limit).map((issue) => {
    const path = formatPath([...prefix, ...issue.path]);
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  const more = error.issues.length - limit;
  if (more > 0) lines.push(`and ${more} more problem${more === 1 ? '' : 's'}`);
  return lines.join('; ');
}
