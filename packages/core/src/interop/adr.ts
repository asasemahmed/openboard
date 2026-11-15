/**
 * Decision cards as Architecture Decision Records: one Markdown file per
 * `decision` node, in the common Nygard form (title, date, Status, Context,
 * Decision, Consequences), plus the cards it is connected to.
 *
 * `planAdrs` is pure: it gets the board and the files already in the ADR
 * folder and says which files to write. Each file records its board and node
 * id in an HTML comment under the title, so a rerun finds it again, keeps its
 * number and its name (even when the card's title changed) and rewrites only
 * its text. New decisions get the numbers after the highest one in the
 * folder. Nothing is ever renumbered, renamed or deleted.
 */
import type { Board, BoardEdge, BoardNode, Status } from '../schema.js';
import { BUILTIN_NODE_TYPE_INFO } from '../typedefs.js';
import { compareStrings } from '../util.js';
import { escapeMarkdown, renderLink } from './markdown.js';
import { oneLine, STATUS_WORDS, typeWords } from './text.js';

/** A file already in the ADR folder. */
export interface AdrExistingFile {
  /** The file name, without a directory. */
  name: string;
  /** Its text; leave it out for an entry that is not a readable file (it still holds its number). */
  text?: string;
}

export type AdrAction = 'create' | 'update' | 'unchanged';

/** One decision and the file it goes to. */
export interface AdrFile {
  /** File name inside the ADR folder: never a path, never `.` or `..`. */
  name: string;
  /** The ADR number, from the file name; absent only for a recorded file whose name has none. */
  number?: number;
  nodeId: string;
  title: string;
  action: AdrAction;
  /** The full text of the file. */
  text: string;
}

export interface AdrPlan {
  /** Every decision on the board, by number. */
  files: AdrFile[];
  /** Files recorded for this board whose card is gone or no longer a decision. They are left alone. */
  kept: { name: string; nodeId: string }[];
  warnings: string[];
}

/** Board statuses as ADR status words. A decision with no status is proposed. */
export const ADR_STATUS: Record<Status, string> = {
  todo: 'Proposed',
  in_progress: 'Proposed',
  blocked: 'Proposed',
  done: 'Accepted',
  cancelled: 'Rejected',
};

const MARKER = /<!--\s*openboard-adr\s+board=([A-Za-z0-9_.:-]+)\s+node=([A-Za-z0-9_.:-]+)\s*-->/;

/** The comment that ties a file to its card. */
export function adrMarker(boardId: string, nodeId: string): string {
  return `<!-- openboard-adr board=${boardId} node=${nodeId} -->`;
}

/** The board and node a file records, from the first marker in it. */
export function parseAdrMarker(text: string): { boardId: string; nodeId: string } | undefined {
  const match = MARKER.exec(text);
  return match ? { boardId: match[1] as string, nodeId: match[2] as string } : undefined;
}

const SLUG_MAX = 50;

/**
 * A file-name part made from a title: lowercase ASCII letters, digits and
 * dashes only, at most 50 characters, `decision` when nothing is left. It can
 * hold no dot, slash or backslash, so it never leaves the folder.
 */
export function adrSlug(title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let slug = words;
  if (slug.length > SLUG_MAX) {
    const cut = slug.slice(0, SLUG_MAX + 1);
    const dash = cut.lastIndexOf('-');
    slug = (dash > 0 ? cut.slice(0, dash) : cut.slice(0, SLUG_MAX)).replace(/-+$/, '');
  }
  return slug || 'decision';
}

/** `0007-use-postgres.md`. */
export function adrFileName(number: number, title: string): string {
  return `${String(number).padStart(4, '0')}-${adrSlug(title)}.md`;
}

/** A plain file name for a Markdown file: no directory part, not hidden. */
function isSafeName(name: string): boolean {
  return /^[^/\\\0]+\.md$/i.test(name) && !name.startsWith('.');
}

function numberOf(name: string): number | undefined {
  const match = /^(\d+)-/.exec(name);
  return match ? Number(match[1]) : undefined;
}

// ── Body sections ────────────────────────────────────────────────────────────

type Section = 'context' | 'decision' | 'consequences';
const SECTION_NAMES = new Set<string>(['context', 'decision', 'consequences']);
const FENCE = /^\s{0,3}(```|~~~)/;
const ATX_HEADING = /^\s{0,3}(#{1,6})(?=\s|$)/;

/** Lines outside code fences, with a flag telling which is which. */
function markFences(lines: readonly string[]): boolean[] {
  let fence: string | undefined;
  return lines.map((line) => {
    const match = FENCE.exec(line);
    if (match) {
      const marker = match[1] as string;
      if (fence === undefined) fence = marker;
      else if (marker === fence) fence = undefined;
      return true;
    }
    return fence !== undefined;
  });
}

/**
 * Split a body at headings named Context, Decision or Consequences (any
 * level). Text before the first such heading belongs to the decision. A body
 * with none of them is all decision.
 */
export function splitDecisionBody(body: string): Record<Section, string> {
  const lines = body.split('\n');
  const inFence = markFences(lines);
  const parts: Record<Section, string[]> = { context: [], decision: [], consequences: [] };
  let current: Section = 'decision';
  lines.forEach((line, i) => {
    if (!inFence[i]) {
      const match = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      const name = match?.[1]?.replace(/:$/, '').trim().toLowerCase();
      if (name && SECTION_NAMES.has(name)) {
        current = name as Section;
        return;
      }
    }
    parts[current].push(line);
  });
  const text = (section: Section) => parts[section].join('\n').trim();
  return {
    context: text('context'),
    decision: text('decision'),
    consequences: text('consequences'),
  };
}

/** Move headings down so the highest one is level 3, below the ADR's own `##` sections. */
function demoteHeadings(text: string): string {
  const lines = text.split('\n');
  const inFence = markFences(lines);
  let top = 7;
  lines.forEach((line, i) => {
    const match = inFence[i] ? null : ATX_HEADING.exec(line);
    if (match) top = Math.min(top, (match[1] as string).length);
  });
  if (top >= 3) return text;
  const shift = 3 - top;
  return lines
    .map((line, i) => {
      if (inFence[i]) return line;
      return line.replace(ATX_HEADING, (hashes) => {
        const level = Math.min(6, hashes.trim().length + shift);
        return hashes.replace(/#+/, '#'.repeat(level));
      });
    })
    .join('\n');
}

// ── Rendering ────────────────────────────────────────────────────────────────

const OUTGOING: Record<string, string> = {
  relates_to: 'Related to',
  depends_on: 'Depends on',
  blocks: 'Blocks',
  implements: 'Implements',
  evidence_for: 'Evidence for',
  flows_to: 'Leads to',
};

const INCOMING: Record<string, string> = {
  relates_to: 'Related to',
  depends_on: 'Needed by',
  blocks: 'Blocked by',
  implements: 'Implemented by',
  evidence_for: 'Evidence from',
  flows_to: 'Follows from',
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function relation(edge: BoardEdge, outgoing: boolean): string {
  const known = (outgoing ? OUTGOING : INCOMING)[edge.type];
  if (known) return known;
  const words = capitalize(typeWords(edge.type));
  return outgoing ? words : `${words} (from)`;
}

function typeLabel(type: string): string {
  const builtin = BUILTIN_NODE_TYPE_INFO[type as keyof typeof BUILTIN_NODE_TYPE_INFO];
  return builtin ? builtin.label.toLowerCase() : typeWords(type);
}

function day(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function actorName(board: Board, id: string): string {
  const actor = board.actors[id];
  if (!actor) return escapeMarkdown(id);
  const name = escapeMarkdown(actor.name);
  return actor.kind === 'agent' ? `${name} (agent)` : name;
}

/** A note or document named "Context" or "Consequences", as the decision record template links them. */
function linkedSection(node: BoardNode): Section | undefined {
  if (node.type !== 'note' && node.type !== 'doc') return undefined;
  const name = oneLine(node.title).replace(/:$/, '').toLowerCase();
  return name === 'context' || name === 'consequences' ? name : undefined;
}

function heading(number: number | undefined, title: string): string {
  const text = escapeMarkdown(title);
  return number === undefined ? `# ${text}` : `# ${number}. ${text}`;
}

const NOT_RECORDED = '_Not recorded on the board._';

function renderAdr(
  board: Board,
  node: BoardNode,
  number: number | undefined,
  edges: readonly BoardEdge[],
  fileOf: ReadonlyMap<string, { name: string; number?: number }>,
): string {
  const sections = splitDecisionBody(node.body ?? '');
  const related: string[] = [];
  const neighbours = edges
    .map((edge) => {
      const outgoing = edge.source === node.id;
      const other = board.nodes[outgoing ? edge.target : edge.source];
      return other ? { edge, outgoing, other } : undefined;
    })
    .filter((entry) => entry !== undefined)
    .sort(
      (a, b) =>
        compareStrings(oneLine(a.other.title), oneLine(b.other.title)) ||
        compareStrings(a.edge.id, b.edge.id),
    );
  for (const { edge, outgoing, other } of neighbours) {
    const section = linkedSection(other);
    if (section && !sections[section] && other.body?.trim()) {
      sections[section] = other.body.trim();
      continue;
    }
    const file = other.type === 'decision' ? fileOf.get(other.id) : undefined;
    const title = file
      ? `[${heading(file.number, other.title).slice(2)}](${encodeURIComponent(file.name)})`
      : escapeMarkdown(other.title);
    const status = other.status
      ? ` (${other.type === 'decision' ? ADR_STATUS[other.status].toLowerCase() : STATUS_WORDS[other.status]})`
      : '';
    const label = edge.label?.trim() ? ` — ${escapeMarkdown(edge.label)}` : '';
    related.push(
      `- ${relation(edge, outgoing)} ${escapeMarkdown(typeLabel(other.type))}: ${title}${status}${label}`,
    );
  }
  for (const link of node.links ?? []) related.push(`- Link: ${renderLink(link)}`);

  const status = node.status ?? 'todo';
  const statusLine =
    status === 'in_progress' || status === 'blocked'
      ? `${ADR_STATUS[status]} (${STATUS_WORDS[status]} on the board)`
      : ADR_STATUS[status];
  let who = `Recorded by ${actorName(board, node.createdBy)} on ${day(node.createdAt)}.`;
  if (node.updatedBy !== node.createdBy || day(node.updatedAt) !== day(node.createdAt)) {
    who += ` Last changed by ${actorName(board, node.updatedBy)} on ${day(node.updatedAt)}.`;
  }

  const body = (text: string) => (text ? demoteHeadings(text) : NOT_RECORDED);
  const blocks = [
    heading(number, node.title),
    adrMarker(board.id, node.id),
    `Date: ${day(node.createdAt)}`,
    '## Status',
    statusLine,
    who,
    '## Context',
    body(sections.context),
    '## Decision',
    body(sections.decision),
    '## Consequences',
    body(sections.consequences),
  ];
  if (related.length) blocks.push('## Related', related.join('\n'));
  return `${blocks.join('\n\n')}\n`;
}

// ── Planning ─────────────────────────────────────────────────────────────────

/**
 * Which ADR files to write for the decisions on `board`, given the files
 * already in the folder. Pure: it reads and writes nothing.
 */
export function planAdrs(board: Board, existing: readonly AdrExistingFile[]): AdrPlan {
  const warnings: string[] = [];
  const decisions = Object.values(board.nodes)
    .filter((node) => node.type === 'decision')
    .sort((a, b) => compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id));
  const isDecision = new Set(decisions.map((node) => node.id));

  // Files this board recorded before, by node: the lowest-numbered one wins.
  const sorted = existing
    .filter((file) => isSafeName(file.name))
    .sort(
      (a, b) =>
        (numberOf(a.name) ?? Number.POSITIVE_INFINITY) -
          (numberOf(b.name) ?? Number.POSITIVE_INFINITY) || compareStrings(a.name, b.name),
    );
  const recorded = new Map<string, AdrExistingFile & { text: string }>();
  const kept: AdrPlan['kept'] = [];
  for (const file of sorted) {
    if (file.text === undefined) continue;
    const marker = parseAdrMarker(file.text);
    if (!marker || marker.boardId !== board.id) continue;
    const first = recorded.get(marker.nodeId);
    if (first) {
      warnings.push(
        `${file.name} records the same card as ${first.name} (${marker.nodeId}); it is left as it is`,
      );
      continue;
    }
    recorded.set(marker.nodeId, { name: file.name, text: file.text });
    if (!isDecision.has(marker.nodeId)) kept.push({ name: file.name, nodeId: marker.nodeId });
  }

  // Every name in the folder holds its number, readable or not, ours or not.
  let next = 1;
  for (const file of existing) {
    const number = numberOf(file.name);
    if (number !== undefined && Number.isSafeInteger(number)) next = Math.max(next, number + 1);
  }

  const fileOf = new Map<string, { name: string; number?: number }>();
  for (const node of decisions) {
    const before = recorded.get(node.id);
    if (before) {
      const number = numberOf(before.name);
      fileOf.set(
        node.id,
        number === undefined ? { name: before.name } : { name: before.name, number },
      );
    } else {
      const number = next++;
      fileOf.set(node.id, { name: adrFileName(number, oneLine(node.title)), number });
    }
  }

  const edgesOf = new Map<string, BoardEdge[]>();
  for (const edge of Object.values(board.edges)) {
    for (const end of [edge.source, edge.target]) {
      if (!isDecision.has(end)) continue;
      const list = edgesOf.get(end);
      if (list) list.push(edge);
      else edgesOf.set(end, [edge]);
    }
  }

  const files = decisions.map((node): AdrFile => {
    const file = fileOf.get(node.id) as { name: string; number?: number };
    const text = renderAdr(board, node, file.number, edgesOf.get(node.id) ?? [], fileOf);
    const before = recorded.get(node.id);
    const action: AdrAction = !before ? 'create' : before.text === text ? 'unchanged' : 'update';
    return {
      name: file.name,
      ...(file.number !== undefined ? { number: file.number } : {}),
      nodeId: node.id,
      title: node.title,
      action,
      text,
    };
  });
  files.sort(
    (a, b) =>
      (a.number ?? Number.POSITIVE_INFINITY) - (b.number ?? Number.POSITIVE_INFINITY) ||
      compareStrings(a.name, b.name),
  );
  kept.sort((a, b) => compareStrings(a.name, b.name));
  return { files, kept, warnings };
}
