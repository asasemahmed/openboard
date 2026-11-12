/**
 * Mermaid export: a `flowchart` with frames as (nested) subgraphs, node types
 * as shapes, statuses as classes, and edge types as line styles and labels.
 *
 * Only long-standing flowchart syntax is used, so the output renders in any
 * Mermaid of the last few years. Every label is quoted and every character
 * that could end a quote, open markup or start an entity is written as a
 * Mermaid entity code, so no title can break the diagram.
 */
import { orderNodes } from '../query.js';
import type { Board, BoardEdge, BoardNode, Status } from '../schema.js';
import { compareStrings } from '../util.js';
import { SHAPE_BY_TYPE, SHAPES } from './mermaid-shapes.js';
import { oneLine, typeWords } from './text.js';

export type MermaidDirection = 'TD' | 'LR';

export interface MermaidOptions {
  direction?: MermaidDirection;
}

/** Words Mermaid reads as keywords when they appear as ids. */
const RESERVED = new Set([
  'end',
  'graph',
  'flowchart',
  'subgraph',
  'direction',
  'style',
  'linkstyle',
  'classdef',
  'class',
  'click',
  'call',
  'href',
  'default',
  'interpolate',
  'accTitle',
  'accDescr',
]);

/**
 * Mermaid-safe identifiers for board ids: letters, digits and underscores,
 * never a keyword and never starting with a digit. Ids that sanitise to the
 * same text get a numbered suffix, assigned in id order so the mapping is
 * stable.
 */
export function mermaidIds(ids: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const id of [...ids].sort(compareStrings)) {
    let base = id.replace(/[^A-Za-z0-9_]/g, '_');
    if (!/^[A-Za-z]/.test(base) || RESERVED.has(base.toLowerCase())) base = `n_${base}`;
    let candidate = base;
    for (let i = 2; taken.has(candidate); i++) candidate = `${base}_${i}`;
    taken.add(candidate);
    out.set(id, candidate);
  }
  return out;
}

/**
 * A quoted Mermaid label. Quotes, markup, entity starts, pipes and backticks
 * become entity codes (`#quot;`, `#35;`, ...); newlines become spaces.
 * Brackets need no escaping inside quotes.
 */
export function mermaidLabel(text: string): string {
  const escaped = oneLine(text).replace(/[#"<>&|`]/g, (char) => {
    switch (char) {
      case '"':
        return '#quot;';
      case '<':
        return '#lt;';
      case '>':
        return '#gt;';
      case '&':
        return '#amp;';
      default:
        return `#${char.charCodeAt(0)};`;
    }
  });
  return `"${escaped}"`;
}

const STATUS_CLASSES: Record<Status, string> = {
  todo: 'fill:#ffffff,stroke:#5f646d,color:#15171a',
  in_progress: 'fill:#fff4ee,stroke:#c2410c,stroke-width:2px,color:#15171a',
  blocked: 'fill:#fdeceb,stroke:#b42318,stroke-width:2px,color:#15171a',
  done: 'fill:#e9f6f0,stroke:#0b7a55,color:#15171a',
  cancelled: 'fill:#f1eee7,stroke:#747983,stroke-dasharray:4 3,color:#5f646d',
};

function arrowFor(edge: BoardEdge): string {
  if (edge.type === 'relates_to') return '-.->';
  if (edge.type === 'blocks') return '==>';
  return '-->';
}

/** The board as a Mermaid flowchart. */
export function toMermaid(board: Board, options: MermaidOptions = {}): string {
  const direction = options.direction === 'LR' ? 'LR' : 'TD';
  const ids = mermaidIds(Object.keys(board.nodes));
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

  const lines: string[] = [
    '---',
    `title: ${JSON.stringify(oneLine(board.name))}`,
    '---',
    `flowchart ${direction}`,
  ];
  const emitted = new Set<string>();
  const declare = (node: BoardNode, pad: string) => {
    emitted.add(node.id);
    const id = ids.get(node.id) as string;
    if (node.type === 'frame') {
      lines.push(`${pad}subgraph ${id} [${mermaidLabel(node.title)}]`);
      for (const child of kids.get(node.id) ?? []) declare(child, `${pad}  `);
      lines.push(`${pad}end`);
      return;
    }
    const shape = SHAPES[SHAPE_BY_TYPE[node.type] ?? 'rect'];
    lines.push(`${pad}${id}${shape.open}${mermaidLabel(node.title)}${shape.close}`);
  };
  for (const node of kids.get(undefined) ?? []) declare(node, '  ');
  // Nodes caught in a parent cycle (invalid boards only) are declared at the top level.
  for (const node of ordered) if (!emitted.has(node.id)) declare({ ...node, type: 'note' }, '  ');

  const edges = Object.keys(board.edges)
    .sort(compareStrings)
    .map((id) => board.edges[id] as BoardEdge)
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  for (const edge of edges) {
    const label = edge.label?.trim() ? edge.label : typeWords(edge.type);
    lines.push(
      `  ${ids.get(edge.source)} ${arrowFor(edge)}|${mermaidLabel(label)}| ${ids.get(edge.target)}`,
    );
  }

  const byStatus = new Map<Status, string[]>();
  for (const node of ordered) {
    if (!node.status || node.type === 'frame') continue;
    const list = byStatus.get(node.status);
    if (list) list.push(ids.get(node.id) as string);
    else byStatus.set(node.status, [ids.get(node.id) as string]);
  }
  for (const [status, style] of Object.entries(STATUS_CLASSES) as Array<[Status, string]>) {
    const members = byStatus.get(status);
    if (!members) continue;
    lines.push(`  classDef status_${status} ${style}`);
    lines.push(`  class ${members.join(',')} status_${status}`);
  }
  return `${lines.join('\n')}\n`;
}
