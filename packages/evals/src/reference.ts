/**
 * Helpers for reference solutions. A reference may only use ids it has seen in
 * tool output, like an agent; these read them out of the rendered text.
 */
import { type TitleMatch, titleMatches } from './board.js';

/** `n_k3x9a0bq2m "Title"`: an id with a prefix and an underscore, then a JSON string. */
const NODE_LINE = /(?:^|[\s(])([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_.:-]+) ("(?:[^"\\]|\\.)*")/gm;

/** Every `id "title"` pair in a tool result, in order. */
export function idsInText(text: string): Array<{ id: string; title: string }> {
  const found: Array<{ id: string; title: string }> = [];
  for (const match of text.matchAll(NODE_LINE)) {
    try {
      found.push({ id: match[1] as string, title: JSON.parse(match[2] as string) as string });
    } catch {
      // Not a JSON string after all.
    }
  }
  return found;
}

const HEADER = /^\s*\[([^\]]+)\] (\S+) ("(?:[^"\\]|\\.)*")/gm;

/** The nodes a read rendered: every `[type] id "title"` header line, in order. */
export function nodesInText(text: string): Array<{ type: string; id: string; title: string }> {
  const found: Array<{ type: string; id: string; title: string }> = [];
  for (const match of text.matchAll(HEADER)) {
    try {
      found.push({
        type: match[1] as string,
        id: match[2] as string,
        title: JSON.parse(match[3] as string) as string,
      });
    } catch {
      // Not a JSON string after all.
    }
  }
  return found;
}

/** The id shown next to a title in a tool result; throws when the result does not show it. */
export function idOf(text: string, title: TitleMatch): string {
  const hit = idsInText(text).find((pair) => titleMatches(pair.title, title));
  if (!hit) throw new Error(`no id for ${String(title)} in:\n${text}`);
  return hit.id;
}

/** `name=id` pairs from a `Refs:` line of a `board_apply` result. */
export function refsInText(text: string): Record<string, string> {
  const line = text.split('\n').find((l) => l.startsWith('Refs'));
  if (!line) return {};
  const body = line.slice(line.indexOf(':') + 1);
  const refs: Record<string, string> = {};
  for (const pair of body.split(',')) {
    const [name, id] = pair.trim().split('=');
    if (name && id) refs[name] = id;
  }
  return refs;
}
