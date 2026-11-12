/**
 * Markdown export: a document a person can read in a pull request.
 *
 * The board name is the title, followed by its description. Nodes outside any
 * frame come first, then each frame as a heading (nested frames one level
 * deeper), in reading order. Every node is a list item: tasks as checkboxes,
 * everything else prefixed with its type. A node's body follows as an indented
 * paragraph with its markdown kept, then its tags, links and outgoing
 * relationships as a short nested list.
 */
import { orderNodes } from '../query.js';
import type { Board, BoardEdge, BoardNode, Link } from '../schema.js';
import { compareStrings } from '../util.js';
import { oneLine, STATUS_WORDS, typeWords } from './text.js';

/** Escape text so it renders literally inside a line of markdown. */
export function escapeMarkdown(text: string): string {
  return oneLine(text).replace(/[\\`*_{}[\]<>#|~$&]/g, (char) => `\\${char}`);
}

/** Inline code that holds any text, backticks included. */
export function codeSpan(text: string): string {
  const flat = oneLine(text);
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

const SAFE_URL = /^(https?:|mailto:)/i;

function linkDestination(target: string): string {
  return encodeURI(target).replace(/[()]/g, (char) => (char === '(' ? '%28' : '%29'));
}

function renderLink(link: Link): string {
  const range =
    link.line !== undefined
      ? `:${link.line}${link.endLine !== undefined ? `-${link.endLine}` : ''}`
      : '';
  switch (link.kind) {
    case 'url':
      return SAFE_URL.test(link.target)
        ? `[${escapeMarkdown(link.target)}](${linkDestination(link.target)})`
        : codeSpan(link.target);
    case 'file': {
      const anchor =
        link.line !== undefined
          ? `#L${link.line}${link.endLine !== undefined ? `-L${link.endLine}` : ''}`
          : '';
      return `[${escapeMarkdown(`${link.target}${range}`)}](${linkDestination(link.target)}${anchor})`;
    }
    case 'symbol':
      return `symbol ${codeSpan(link.target)}`;
    case 'commit':
      return `commit ${codeSpan(link.target)}`;
    case 'pr':
      return SAFE_URL.test(link.target)
        ? `pull request [${escapeMarkdown(link.target)}](${linkDestination(link.target)})`
        : `pull request ${codeSpan(link.target)}`;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() ? prefix + line : ''))
    .join('\n');
}

export interface MarkdownOptions {
  /** Leave out bodies, for a short overview. */
  bodies?: boolean;
}

/** The board as a markdown document. */
export function toMarkdown(board: Board, options: MarkdownOptions = {}): string {
  const showBodies = options.bodies ?? true;
  const ordered = orderNodes(board, Object.values(board.nodes));
  const kids = new Map<string | undefined, BoardNode[]>();
  for (const node of ordered) {
    const parent =
      node.parent !== undefined && board.nodes[node.parent]?.type === 'frame'
        ? node.parent
        : undefined;
    const list = kids.get(parent);
    if (list) list.push(node);
    else kids.set(parent, [node]);
  }
  const outgoing = new Map<string, BoardEdge[]>();
  for (const id of Object.keys(board.edges).sort(compareStrings)) {
    const edge = board.edges[id] as BoardEdge;
    const list = outgoing.get(edge.source);
    if (list) list.push(edge);
    else outgoing.set(edge.source, [edge]);
  }
  const titleOf = (id: string) => {
    const node = board.nodes[id];
    return node ? escapeMarkdown(node.title) : codeSpan(id);
  };

  const details = (node: BoardNode): string[] => {
    const lines: string[] = [];
    if (node.tags?.length) lines.push(`Tags: ${node.tags.map(codeSpan).join(', ')}`);
    if (node.links?.length) lines.push(`Links: ${node.links.map(renderLink).join(', ')}`);
    for (const edge of outgoing.get(node.id) ?? []) {
      const label = edge.label ? ` (${escapeMarkdown(edge.label)})` : '';
      lines.push(`${typeWords(edge.type)}: ${titleOf(edge.target)}${label}`);
    }
    return lines;
  };

  const item = (node: BoardNode): string => {
    const title = escapeMarkdown(node.title);
    let head: string;
    if (node.type === 'task') {
      const box = node.status === 'done' ? '[x]' : '[ ]';
      const words =
        node.status && node.status !== 'todo' && node.status !== 'done'
          ? ` (${STATUS_WORDS[node.status]})`
          : '';
      head = `- ${box} ${title}${words}`;
    } else {
      const status = node.status ? ` (${STATUS_WORDS[node.status]})` : '';
      head = `- **${escapeMarkdown(capitalize(typeWords(node.type)))}:** ${title}${status}`;
    }
    const parts = [head];
    if (showBodies && node.body?.trim()) parts.push('', indent(node.body.trimEnd(), '  '));
    const extra = details(node);
    if (extra.length) {
      if (parts.length > 1) parts.push('');
      for (const line of extra) parts.push(`  - ${line}`);
    }
    return parts.join('\n');
  };

  const blocks: string[] = [`# ${escapeMarkdown(board.name)}`];
  if (board.description?.trim()) blocks.push(board.description.trim());

  const done = new Set<string>();
  const section = (parent: string | undefined, level: number) => {
    const list = (kids.get(parent) ?? []).filter((node) => !done.has(node.id));
    for (const node of list) done.add(node.id);
    const cards = list.filter((node) => node.type !== 'frame');
    if (cards.length) blocks.push(cards.map(item).join('\n'));
    for (const frame of list.filter((node) => node.type === 'frame')) {
      const heading = `${'#'.repeat(Math.min(6, level))} ${escapeMarkdown(frame.title)}`;
      const status = frame.status ? ` (${STATUS_WORDS[frame.status]})` : '';
      blocks.push(heading + status);
      if (showBodies && frame.body?.trim()) blocks.push(frame.body.trim());
      const extra = details(frame);
      if (extra.length) blocks.push(extra.map((line) => `- ${line}`).join('\n'));
      section(frame.id, level + 1);
    }
  };
  section(undefined, 2);
  // Only an invalid board (a parent cycle) leaves nodes unvisited; list them rather than lose them.
  const rest = ordered.filter((node) => !done.has(node.id));
  if (rest.length) blocks.push(rest.map(item).join('\n'));

  return `${blocks.join('\n\n')}\n`;
}
