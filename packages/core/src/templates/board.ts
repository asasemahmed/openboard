/**
 * A board used as a template: its nodes, edges and views become one batch
 * that creates copies with fresh ids. Comments and bookkeeping are not copied;
 * whoever applies the batch becomes the author of everything in it.
 */
import type { Op } from '../ops.js';
import type { Board, BoardNode, Link } from '../schema.js';
import { cloneJson, compareStrings } from '../util.js';

export interface BoardTemplateOptions {
  /**
   * Keep the positions of nodes at the top of the template. Off by default:
   * they are left to the layout engine, so the copy finds free room on a board
   * that already has content. Nodes inside frames always keep their position,
   * which is relative to their frame.
   */
  keepTopLevelViews?: boolean;
}

/** Links are copied without what the server keeps on them (hash, stale), so they are checked afresh. */
function freshLink(link: Link): Link {
  const { hash: _hash, stale: _stale, ...rest } = link;
  return rest;
}

/** Depth of a node in its frame tree (0 at the top); cycles and missing parents count as the top. */
function depthOf(board: Board, node: BoardNode): number {
  let depth = 0;
  const seen = new Set<string>([node.id]);
  let parent = node.parent;
  while (parent !== undefined && board.nodes[parent] && !seen.has(parent)) {
    seen.add(parent);
    depth++;
    parent = board.nodes[parent]?.parent;
  }
  return depth;
}

/** The batch that copies `board` onto another board. Parents come before their children. */
export function opsFromBoard(board: Board, options: BoardTemplateOptions = {}): Op[] {
  const nodes = Object.values(board.nodes).sort(
    (a, b) => depthOf(board, a) - depthOf(board, b) || compareStrings(a.id, b.id),
  );
  const refs = new Map<string, string>();
  nodes.forEach((node, index) => refs.set(node.id, `t${index + 1}`));
  const ops: Op[] = [];
  for (const node of nodes) {
    const input: Extract<Op, { op: 'add_node' }>['node'] = { type: node.type, title: node.title };
    if (node.body !== undefined) input.body = node.body;
    if (node.status !== undefined) input.status = node.status;
    if (node.tags !== undefined) input.tags = [...node.tags];
    if (node.props !== undefined) input.props = cloneJson(node.props);
    if (node.links !== undefined) input.links = node.links.map(freshLink);
    const parentRef = node.parent !== undefined ? refs.get(node.parent) : undefined;
    if (parentRef !== undefined) input.parent = `$${parentRef}`;
    if (node.view && (parentRef !== undefined || options.keepTopLevelViews)) {
      input.view = { ...node.view };
    }
    ops.push({ op: 'add_node', ref: refs.get(node.id) as string, node: input });
  }
  for (const edge of Object.values(board.edges).sort((a, b) => compareStrings(a.id, b.id))) {
    const source = refs.get(edge.source);
    const target = refs.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const input: Extract<Op, { op: 'add_edge' }>['edge'] = {
      type: edge.type,
      source: `$${source}`,
      target: `$${target}`,
    };
    if (edge.label !== undefined) input.label = edge.label;
    ops.push({ op: 'add_edge', edge: input });
  }
  return ops;
}
