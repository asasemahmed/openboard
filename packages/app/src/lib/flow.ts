/**
 * Board -> React Flow. Pure functions; the store calls them per changed
 * entry so unchanged nodes keep their object identity (and stay memoised).
 */
import {
  type BoardEdge,
  type BoardNode,
  defaultNodeSize,
  FRAME_MIN,
  FRAME_PADDING,
  type Size,
} from '@openboard/core';
import type { Edge, Node } from '@xyflow/react';
import type { Placement, PlacementMap } from './geometry.js';

export interface CardData extends Record<string, unknown> {
  node: BoardNode;
  /** Not on the board yet: shown dashed until someone accepts it. */
  ghost: boolean;
}

export interface EdgeData extends Record<string, unknown> {
  edge: BoardEdge;
  ghost: boolean;
}

export type FlowNode = Node<CardData, 'card' | 'frame'>;
export type FlowEdge = Edge<EdgeData, 'board'>;

/** The size a node is drawn at: its view's size, else the shared default. */
export function nodeSize(node: BoardNode): Size {
  const fallback = node.type === 'frame' ? { ...FRAME_MIN } : defaultNodeSize(node);
  return { w: node.view?.w ?? fallback.w, h: node.view?.h ?? fallback.h };
}

/** Where a node without a view is drawn until the layout engine places it. */
function fallbackPosition(node: BoardNode): { x: number; y: number } {
  return node.parent ? { x: FRAME_PADDING.left, y: FRAME_PADDING.top } : { x: 0, y: 0 };
}

export interface FlowNodeOptions {
  selected?: boolean;
  ghost?: boolean;
}

export function toFlowNode(node: BoardNode, opts: FlowNodeOptions = {}): FlowNode {
  const size = nodeSize(node);
  const isFrame = node.type === 'frame';
  const flow: FlowNode = {
    id: node.id,
    type: isFrame ? 'frame' : 'card',
    position: node.view ? { x: node.view.x, y: node.view.y } : fallbackPosition(node),
    data: { node, ghost: opts.ghost ?? false },
    width: size.w,
    height: size.h,
    selected: opts.selected ?? false,
  };
  if (node.parent !== undefined) flow.parentId = node.parent;
  if (isFrame) flow.dragHandle = '.frame-handle';
  if (opts.ghost) {
    flow.draggable = false;
    flow.connectable = false;
    flow.selectable = false;
    flow.className = 'is-ghost';
  }
  return flow;
}

export function toFlowEdge(edge: BoardEdge, opts: FlowNodeOptions = {}): FlowEdge {
  return {
    id: edge.id,
    type: 'board',
    source: edge.source,
    target: edge.target,
    data: { edge, ghost: opts.ghost ?? false },
    selected: opts.selected ?? false,
    ...(opts.ghost ? { selectable: false, className: 'is-ghost' } : {}),
  };
}

/**
 * React Flow needs every parent before its children. Sort by depth (stable),
 * so frames come before what they contain and nested frames work.
 */
export function orderFlowNodes<T extends { id: string; parentId?: string }>(
  nodes: readonly T[],
): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const depthOf = (n: T): number => {
    const known = depth.get(n.id);
    if (known !== undefined) return known;
    let d = 0;
    const seen = new Set<string>([n.id]);
    let parent = n.parentId;
    while (parent !== undefined && !seen.has(parent)) {
      const p = byId.get(parent);
      if (!p) break;
      seen.add(parent);
      d++;
      parent = p.parentId;
    }
    depth.set(n.id, d);
    return d;
  };
  return nodes
    .map((n, i) => ({ n, i, d: depthOf(n) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((entry) => entry.n);
}

export function boardToFlow(
  nodes: readonly BoardNode[],
  edges: readonly BoardEdge[],
  selection: { nodeIds?: ReadonlySet<string>; edgeIds?: ReadonlySet<string> } = {},
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return {
    nodes: orderFlowNodes(
      nodes.map((n) => toFlowNode(n, { selected: selection.nodeIds?.has(n.id) ?? false })),
    ),
    edges: edges.map((e) => toFlowEdge(e, { selected: selection.edgeIds?.has(e.id) ?? false })),
  };
}

/** Flatten flow nodes into the shape geometry helpers work on. */
export function placementsOf(nodes: Iterable<FlowNode>): PlacementMap {
  const map = new Map<string, Placement>();
  for (const n of nodes) {
    const size = nodeSize(n.data.node);
    const placement: Placement = {
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      w: n.width ?? n.measured?.width ?? size.w,
      h: n.height ?? n.measured?.height ?? size.h,
      frame: n.type === 'frame',
    };
    if (n.parentId !== undefined) placement.parent = n.parentId;
    map.set(n.id, placement);
  }
  return map;
}
