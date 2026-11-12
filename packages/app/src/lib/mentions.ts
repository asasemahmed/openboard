/**
 * `@` mentions in comments. The text keeps a readable `@Name`; the comment
 * stores actor ids (or `MENTION_AGENTS`) in `mentions`. A picked mention
 * counts only while its `@Name` is still in the text, so deleting it from the
 * text drops it.
 */
import { MENTION_AGENTS } from '@openboard/core';

export interface MentionTarget {
  /** Actor id, or `MENTION_AGENTS`. */
  id: string;
  label: string;
}

export const ALL_AGENTS: MentionTarget = { id: MENTION_AGENTS, label: 'All agents' };

/**
 * The mention being typed at the caret: the `@` that starts it and the text
 * after it. Null when the caret is not in a mention. An `@` only starts a
 * mention at the start of the text or after whitespace or an opening bracket,
 * so e-mail addresses do not open the picker.
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  const prev = at === 0 ? '' : before[at - 1];
  if (prev !== '' && !/[\s([{]/.test(prev ?? '')) return null;
  const query = before.slice(at + 1);
  // A mention is a name: up to a few words, no line breaks.
  if (query.length > 40 || /[\n@]/.test(query) || /\s{2}/.test(query)) return null;
  return { start: at, query };
}

/** Replace the typed `@query` (from `start` to `caret`) with `@Label `. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  label: string,
): { text: string; caret: number } {
  const insert = `@${label} `;
  const after = text.slice(caret).replace(/^ /, '');
  return { text: text.slice(0, start) + insert + after, caret: start + insert.length };
}

/** Targets whose name matches what was typed, best first. */
export function matchTargets(targets: readonly MentionTarget[], query: string): MentionTarget[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...targets];
  const starts = targets.filter((t) => t.label.toLowerCase().startsWith(q));
  const contains = targets.filter((t) => !starts.includes(t) && t.label.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/** The ids of picked mentions whose `@Label` is still in the text, without duplicates. */
export function mentionsIn(text: string, picked: readonly MentionTarget[]): string[] {
  const out: string[] = [];
  for (const target of picked) {
    if (out.includes(target.id)) continue;
    if (text.includes(`@${target.label}`)) out.push(target.id);
  }
  return out;
}
