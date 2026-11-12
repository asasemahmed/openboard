/**
 * Words for merge conflicts: how values and items are named in messages, and
 * the plain-text report for a terminal.
 */
import { clip, oneLine, typeWords } from '../interop/text.js';
import type { MergeConflict } from './types.js';

/** A title in quotes, cut to a readable length. */
export function quoted(title: string): string {
  return `"${clip(oneLine(title), 60)}"`;
}

/** A short rendering of a field value for a message. */
export function show(value: unknown): string {
  if (value === undefined || value === null) return 'nothing';
  if (typeof value === 'string') return quoted(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    const items = value.map((item) =>
      typeof item === 'object' && item !== null && 'target' in item
        ? String((item as { target: unknown }).target)
        : String(item),
    );
    return clip(items.join(', '), 60);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.x === 'number' && typeof record.y === 'number') {
      return `position ${Math.round(record.x)},${Math.round(record.y)}`;
    }
    return clip(JSON.stringify(value), 60);
  }
  return clip(String(value), 60);
}

/** "the depends on edge from "A" to "B"". */
export function edgePhrase(type: string, source: string, target: string): string {
  return `the ${typeWords(type)} edge from ${quoted(source)} to ${quoted(target)}`;
}

const RESOLUTION_WORDS: Record<MergeConflict['resolution'], string> = {
  ours: 'kept ours',
  theirs: 'kept theirs',
  kept: 'kept',
  dropped: 'dropped',
  repaired: 'repaired',
};

/** A short plain-text report of merge conflicts, one per line, for a terminal. */
export function renderConflicts(conflicts: readonly MergeConflict[]): string {
  if (conflicts.length === 0) return 'Merged cleanly: no conflicts.\n';
  const lines = [
    `Merged with ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}, each resolved as shown; review them:`,
  ];
  for (const conflict of conflicts) {
    const where = conflict.field ? `${conflict.id} ${conflict.field}` : conflict.id;
    lines.push(
      `  [${conflict.kind}] ${where} (${RESOLUTION_WORDS[conflict.resolution]}): ${conflict.message}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
