/**
 * Structural repairs after a field-wise merge. Each side was valid on its own,
 * but together they can break the board's rules: an edge to a node the other
 * side removed, two sides adding the same relationship under different ids, a
 * node in a frame the other side removed or turned into a card, or two frames
 * put inside each other. Every repair is deterministic and reported.
 */
import type { BoardEdge, BoardNode, Comment } from '../schema.js';
import { compareStrings, jsonEqual } from '../util.js';
import { type MergeContext, titleIn } from './context.js';
import { edgePhrase, quoted } from './report.js';

export interface Structure {
  nodes: Record<string, BoardNode>;
  edges: Record<string, BoardEdge>;
  comments: Record<string, Comment>;
}

export function repairStructure(
  ctx: MergeContext,
  nodes: Record<string, BoardNode>,
  edges: Record<string, BoardEdge>,
  comments: Record<string, Comment>,
): Structure {
  const out: Structure = { nodes: { ...nodes }, edges: {}, comments };
  repairParents(ctx, out.nodes);
  breakCycles(ctx, out.nodes);
  out.edges = repairEdges(ctx, out.nodes, edges);
  reportDetachedComments(ctx, out.nodes, comments);
  return out;
}

/** A node as it was before the merge, for nodes the merge no longer has. */
function earlier(ctx: MergeContext, id: string): BoardNode | undefined {
  return ctx.base.nodes[id] ?? ctx.ours.nodes[id] ?? ctx.theirs.nodes[id];
}

/**
 * A node whose frame is gone, or is no longer a frame, moves to the nearest
 * frame further up (as removing a frame does), keeping its place on screen
 * when every frame on the way has a position.
 */
function repairParents(ctx: MergeContext, nodes: Record<string, BoardNode>): void {
  const boards = [ctx.ours, ctx.theirs, ctx.base];
  for (const id of Object.keys(nodes).sort(compareStrings)) {
    const node = nodes[id] as BoardNode;
    if (node.parent === undefined || nodes[node.parent]?.type === 'frame') continue;
    const lost = node.parent;
    const gone = !nodes[lost];
    let parent: string | undefined = lost;
    let dx = 0;
    let dy = 0;
    let keepView = node.view !== undefined;
    const seen = new Set<string>([id]);
    while (parent !== undefined && nodes[parent]?.type !== 'frame') {
      if (seen.has(parent)) {
        parent = undefined;
        keepView = false;
        break;
      }
      seen.add(parent);
      const holder: BoardNode | undefined = nodes[parent] ?? earlier(ctx, parent);
      if (keepView && holder?.view) {
        dx += holder.view.x;
        dy += holder.view.y;
      } else keepView = false;
      parent = holder?.parent;
    }
    const { parent: _old, view, ...rest } = node;
    const next: BoardNode = { ...rest };
    if (parent !== undefined) next.parent = parent;
    if (keepView && view) next.view = { ...view, x: view.x + dx, y: view.y + dy };
    nodes[id] = next;
    const into = parent !== undefined ? `; it is now in ${quoted(titleIn(boards, parent))}` : '';
    ctx.conflicts.push({
      kind: 'structure',
      id,
      field: 'parent',
      ours: ctx.ours.nodes[id]?.parent,
      theirs: ctx.theirs.nodes[id]?.parent,
      resolution: 'repaired',
      message: gone
        ? `Moved ${quoted(node.title)} out of frame ${quoted(titleIn(boards, lost))}, which the other side removed${into}.`
        : `Moved ${quoted(node.title)} out of ${quoted(titleIn(boards, lost))}, which is no longer a frame${into}.`,
    });
  }
}

/**
 * When the two sides put frames inside each other, the parent chain loops.
 * The loop is cut at the node with the smallest id, which moves to the canvas.
 */
function breakCycles(ctx: MergeContext, nodes: Record<string, BoardNode>): void {
  const clear = new Set<string>();
  for (const start of Object.keys(nodes).sort(compareStrings)) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined && !clear.has(current)) {
      if (onPath.has(current)) {
        const cycle = path.slice(path.indexOf(current)).sort(compareStrings);
        const cut = cycle[0] as string;
        const node = nodes[cut] as BoardNode;
        const parentTitle = quoted(nodes[node.parent as string]?.title ?? (node.parent as string));
        const { parent: _p, view: _v, ...rest } = node;
        nodes[cut] = rest;
        ctx.conflicts.push({
          kind: 'structure',
          id: cut,
          field: 'parent',
          ours: ctx.ours.nodes[cut]?.parent,
          theirs: ctx.theirs.nodes[cut]?.parent,
          resolution: 'repaired',
          message: `Took ${quoted(node.title)} out of ${parentTitle} because the two sides put these frames inside each other.`,
        });
        break;
      }
      onPath.add(current);
      path.push(current);
      current = nodes[current]?.parent;
    }
    // Everything on a walk that ended without a loop (or after the cut) is settled.
    for (const id of path) clear.add(id);
  }
}

/** Drop edges that lost a node, connect a node to itself, or repeat a relationship. */
function repairEdges(
  ctx: MergeContext,
  nodes: Record<string, BoardNode>,
  edges: Record<string, BoardEdge>,
): Record<string, BoardEdge> {
  const boards = [ctx.ours, ctx.theirs, ctx.base];
  const out: Record<string, BoardEdge> = {};
  const byKey = new Map<string, string>();
  const drop = (edge: BoardEdge, message: string) =>
    ctx.conflicts.push({
      kind: 'structure',
      id: edge.id,
      ours: ctx.ours.edges[edge.id],
      theirs: ctx.theirs.edges[edge.id],
      resolution: 'dropped',
      message,
    });
  for (const id of Object.keys(edges).sort(compareStrings)) {
    const edge = edges[id] as BoardEdge;
    const phrase = edgePhrase(
      edge.type,
      titleIn(boards, edge.source),
      titleIn(boards, edge.target),
    );
    if (nodes[id]) {
      drop(edge, `Dropped ${phrase} because a node has the same id ${quoted(id)}.`);
      continue;
    }
    const missing = [edge.source, edge.target].find((end) => !nodes[end]);
    if (missing !== undefined) {
      drop(edge, `Dropped ${phrase} because ${quoted(titleIn(boards, missing))} was removed.`);
      continue;
    }
    if (edge.source === edge.target) {
      drop(edge, `Dropped ${phrase} because it connects a node to itself.`);
      continue;
    }
    const key = `${edge.type}\u0000${edge.source}\u0000${edge.target}`;
    const kept = byKey.get(key);
    if (kept !== undefined) {
      drop(edge, `Dropped a second copy of ${phrase}; edge ${quoted(kept)} already says the same.`);
      continue;
    }
    byKey.set(key, id);
    out[id] = edge;
  }
  return out;
}

/**
 * A comment stays when its node goes (restoring the node re-attaches it). It
 * is reported when the side that wrote or changed it still had the node, so
 * that side did not see it become detached.
 */
function reportDetachedComments(
  ctx: MergeContext,
  nodes: Record<string, BoardNode>,
  comments: Record<string, Comment>,
): void {
  const boards = [ctx.ours, ctx.theirs, ctx.base];
  for (const id of Object.keys(comments).sort(compareStrings)) {
    const comment = comments[id] as Comment;
    const nodeId = comment.nodeId;
    if (nodeId === undefined || nodes[nodeId]) continue;
    const before = ctx.base.comments?.[id];
    const unaware = [ctx.ours, ctx.theirs].some((side) => {
      const version = side.comments?.[id];
      return (
        version !== undefined && !jsonEqual(version, before) && side.nodes[nodeId] !== undefined
      );
    });
    if (!unaware) continue;
    ctx.conflicts.push({
      kind: 'structure',
      id,
      field: 'nodeId',
      resolution: 'kept',
      message: `A comment on ${quoted(titleIn(boards, nodeId))} is now detached because the other side removed that node; reply on another node or resolve it.`,
    });
  }
}
