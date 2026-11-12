/**
 * Three-way merge of single values, keyed lists (merged as sets) and flat
 * records (merged per key). `undefined` means absent throughout.
 */
import { compareStrings, jsonEqual } from '../util.js';
import type { MergeSide } from './types.js';

export interface Picked<T> {
  value: T | undefined;
  /** Both sides changed it, differently. */
  conflict: boolean;
  /** Where the value came from: unchanged, one side, or both sides alike. */
  from: 'base' | MergeSide | 'both';
}

/** Unchanged on one side: take the other. Changed alike: fine. Changed differently: `prefer`. */
export function merge3<T>(
  base: T | undefined,
  ours: T | undefined,
  theirs: T | undefined,
  prefer: MergeSide,
): Picked<T> {
  if (jsonEqual(ours, theirs)) {
    return { value: ours, conflict: false, from: jsonEqual(ours, base) ? 'base' : 'both' };
  }
  if (jsonEqual(base, ours)) return { value: theirs, conflict: false, from: 'theirs' };
  if (jsonEqual(base, theirs)) return { value: ours, conflict: false, from: 'ours' };
  return { value: prefer === 'ours' ? ours : theirs, conflict: true, from: prefer };
}

/**
 * Like {@link merge3}, but when one side removed the value and the other
 * changed it, the changed value is kept (and it still counts as a conflict).
 */
export function merge3Keep<T>(
  base: T | undefined,
  ours: T | undefined,
  theirs: T | undefined,
  prefer: MergeSide,
): Picked<T> {
  const picked = merge3(base, ours, theirs, prefer);
  if (!picked.conflict || base === undefined) return picked;
  if (ours === undefined) return { value: theirs, conflict: true, from: 'theirs' };
  if (theirs === undefined) return { value: ours, conflict: true, from: 'ours' };
  return picked;
}

function keyed<T>(list: readonly T[], key: (item: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  const seen = new Map<string, number>();
  for (const item of list) {
    const k = key(item);
    const count = seen.get(k) ?? 0;
    seen.set(k, count + 1);
    out.set(count === 0 ? k : `${k}\u0000${count}`, item);
  }
  return out;
}

/** True when the keys both lists share appear in the same relative order. */
function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  const inB = new Set(b);
  const inA = new Set(a);
  const left = a.filter((k) => inB.has(k));
  const right = b.filter((k) => inA.has(k));
  return left.every((k, i) => k === right[i]);
}

/**
 * Merge two edits of a list whose members are identified by `key` (tags by
 * text, links by kind and target). When both sides changed it, members are
 * merged as a set: what either side added is kept, what either side removed
 * is gone, and a member both sides changed differently goes to `prefer`.
 * Members both sides kept stay in their order; additions follow.
 */
export function mergeKeyedList<T>(
  base: readonly T[] | undefined,
  ours: readonly T[] | undefined,
  theirs: readonly T[] | undefined,
  key: (item: T) => string,
  prefer: MergeSide,
): { value: T[] | undefined; conflict: boolean } {
  const simple = merge3(base, ours, theirs, prefer);
  if (!simple.conflict) return { value: simple.value?.slice(), conflict: false };

  const b = keyed(base ?? [], key);
  const o = keyed(ours ?? [], key);
  const t = keyed(theirs ?? [], key);
  let conflict = false;
  const result = new Map<string, T>();
  const keys = new Set([...b.keys(), ...o.keys(), ...t.keys()]);
  for (const k of keys) {
    const picked = merge3Keep(b.get(k), o.get(k), t.get(k), prefer);
    if (picked.conflict) conflict = true;
    if (picked.value !== undefined) result.set(k, picked.value);
  }

  // Order: kept members as a side that reordered them has them, then each side's additions.
  const baseKeys = [...b.keys()];
  const oursKeys = [...o.keys()];
  const theirsKeys = [...t.keys()];
  const oursReordered = !sameOrder(baseKeys, oursKeys);
  const theirsReordered = !sameOrder(baseKeys, theirsKeys);
  let spine = baseKeys;
  if (oursReordered && theirsReordered && !sameOrder(oursKeys, theirsKeys)) {
    conflict = true;
    spine = prefer === 'ours' ? oursKeys : theirsKeys;
  } else if (oursReordered) spine = oursKeys;
  else if (theirsReordered) spine = theirsKeys;
  const ordered = spine.filter((k) => b.has(k) && result.has(k));
  // Additions both sides made come first, then each side's own; which side's
  // block goes first must not depend on which side is "ours".
  const bothOurs = oursKeys.filter((k) => !b.has(k) && t.has(k) && result.has(k));
  const bothTheirs = theirsKeys.filter((k) => !b.has(k) && o.has(k) && result.has(k));
  const common = sameOrder(bothOurs, bothTheirs) ? bothOurs : [...bothOurs].sort(compareStrings);
  const onlyOurs = oursKeys.filter((k) => !b.has(k) && !t.has(k) && result.has(k));
  const onlyTheirs = theirsKeys.filter((k) => !b.has(k) && !o.has(k) && result.has(k));
  const blocks = [onlyOurs, onlyTheirs].sort((x, y) =>
    compareStrings(x.join('\u0001'), y.join('\u0001')),
  );
  const seen = new Set<string>();
  const out: T[] = [];
  for (const k of [
    ...ordered,
    ...common,
    ...(blocks[0] ?? []),
    ...(blocks[1] ?? []),
    ...result.keys(),
  ]) {
    if (seen.has(k) || !result.has(k)) continue;
    seen.add(k);
    out.push(result.get(k) as T);
  }
  return { value: out.length ? out : undefined, conflict };
}

/**
 * Merge a flat record per key: each key is merged on its own, so the two
 * sides may change different keys. Returns the keys that conflicted.
 */
export function mergeRecord<V>(
  base: Readonly<Record<string, V>> | undefined,
  ours: Readonly<Record<string, V>> | undefined,
  theirs: Readonly<Record<string, V>> | undefined,
  prefer: MergeSide,
): { value: Record<string, V> | undefined; conflicts: string[] } {
  const simple = merge3(base, ours, theirs, prefer);
  if (!simple.conflict) {
    return { value: simple.value ? { ...simple.value } : undefined, conflicts: [] };
  }
  const keys = [
    ...new Set([
      ...Object.keys(base ?? {}),
      ...Object.keys(ours ?? {}),
      ...Object.keys(theirs ?? {}),
    ]),
  ].sort(compareStrings);
  const out: Record<string, V> = {};
  const conflicts: string[] = [];
  for (const k of keys) {
    const picked = merge3Keep(base?.[k], ours?.[k], theirs?.[k], prefer);
    if (picked.conflict) conflicts.push(k);
    if (picked.value !== undefined) out[k] = picked.value;
  }
  return { value: Object.keys(out).length ? out : undefined, conflicts };
}
