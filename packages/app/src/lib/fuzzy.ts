/**
 * Small fuzzy matcher for the command palette. Higher scores are better;
 * `null` means no match. Exact and prefix matches beat substrings, which beat
 * scattered subsequences; matches at word starts and in runs score higher.
 */
import type { BoardNode } from '@openboard/core';

const WORD_BREAK = /[\s\-_./:#]/;

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 900 - Math.min(t.length - q.length, 100);
  const at = t.indexOf(q);
  if (at >= 0) {
    const wordStart = at === 0 || WORD_BREAK.test(t.charAt(at - 1));
    return (wordStart ? 800 : 650) - Math.min(at, 100) - Math.min(t.length, 100) / 10;
  }

  // Subsequence: every query character, in order.
  let score = 0;
  let ti = 0;
  let run = 0;
  let firstAt = -1;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    if (firstAt < 0) firstAt = found;
    const wordStart = found === 0 || WORD_BREAK.test(t.charAt(found - 1));
    run = found === ti && ti > 0 ? run + 1 : 0;
    score += 10 + (wordStart ? 12 : 0) + run * 8 - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return Math.max(1, 300 + score - Math.min(firstAt, 50) - Math.min(t.length, 200) / 20);
}

export interface NodeMatch {
  node: BoardNode;
  score: number;
  /** Which field matched best. */
  field: 'title' | 'id' | 'tag';
}

/** Rank nodes by title, id and tags. Ids only match exactly or by prefix. */
export function searchNodes(nodes: readonly BoardNode[], query: string, limit = 50): NodeMatch[] {
  const q = query.trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const out: NodeMatch[] = [];
  for (const node of nodes) {
    let best: NodeMatch | null = null;
    const title = fuzzyScore(q, node.title);
    if (title !== null) best = { node, score: title, field: 'title' };
    const id = node.id.toLowerCase();
    if (id === lower || (lower.length >= 3 && id.startsWith(lower))) {
      const score = id === lower ? 1100 : 950;
      if (!best || score > best.score) best = { node, score, field: 'id' };
    }
    for (const tag of node.tags ?? []) {
      const raw = fuzzyScore(q.replace(/^#/, ''), tag);
      if (raw === null) continue;
      const score = raw * 0.9;
      if (!best || score > best.score) best = { node, score, field: 'tag' };
    }
    if (best) out.push(best);
  }
  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.node.title.length - b.node.title.length ||
      a.node.title.localeCompare(b.node.title),
  );
  return out.slice(0, limit);
}
