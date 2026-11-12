/**
 * Builders for the operation batches the canvas writes. Pure: they read a
 * `PlacementMap` (where things are drawn) and board entries, and return ops.
 * One user gesture is always one batch, so it is one undo step.
 */
import {
  type BoardEdge,
  type BoardNode,
  defaultNodeSize,
  FRAME_MIN,
  FRAME_PADDING,
  type Op,
  type Status,
  snap,
  type View,
} from '@openboard/core';
import {
  absoluteRect,
  boundsOf,
  center,
  clampIntoFrame,
  commonFrame,
  depthOf,
  frameAt,
  framesToGrow,
  type Placement,
  type PlacementMap,
  type Rect,
  toParentSpace,
  topLevelOf,
  type XY,
} from './geometry.js';

function growOps(frames: Iterable<string>, map: PlacementMap): Op[] {
  const ops: Op[] = [];
  for (const [id, size] of framesToGrow(frames, map)) {
    ops.push({ op: 'move_node', id, view: { w: snapUp(size.w), h: snapUp(size.h) } });
  }
  return ops;
}

function snapUp(value: number): number {
  return Math.ceil(value / 8) * 8;
}

function snapXY(p: XY): XY {
  return { x: snap(p.x), y: snap(p.y) };
}

// ── Adding ───────────────────────────────────────────────────────────────────

export interface NewNode {
  id: string;
  type: string;
  title: string;
  status?: Status;
  /** Canvas point the new node is centred on. */
  at: XY;
}

/** Add a node centred on a canvas point, inside whatever frame is under it. */
export function addNodeOps(spec: NewNode, map: PlacementMap): Op[] {
  const isFrame = spec.type === 'frame';
  const size = isFrame
    ? { ...FRAME_MIN }
    : defaultNodeSize({ type: spec.type, title: spec.title, status: spec.status });
  const parent = frameAt(spec.at, map);
  let pos = toParentSpace({ x: spec.at.x - size.w / 2, y: spec.at.y - size.h / 2 }, parent, map);
  if (parent !== undefined) pos = clampIntoFrame(pos);
  pos = snapXY(pos);
  const view: View = { x: pos.x, y: pos.y, pinned: true };
  if (isFrame) {
    view.w = size.w;
    view.h = size.h;
  }
  const ops: Op[] = [
    {
      op: 'add_node',
      id: spec.id,
      node: {
        type: spec.type,
        title: spec.title,
        ...(spec.status ? { status: spec.status } : {}),
        ...(parent !== undefined ? { parent } : {}),
        view,
      },
    },
  ];
  if (parent !== undefined) {
    const working = new Map(map);
    working.set(spec.id, { id: spec.id, parent, ...pos, ...size, frame: isFrame });
    ops.push(...growOps([parent], working));
  }
  return ops;
}

// ── Moving ───────────────────────────────────────────────────────────────────

/**
 * Commit a drag. `map` already holds the dropped positions. A node whose
 * centre ends up over a different frame is reparented in the same batch, with
 * its position converted so it stays exactly where it was dropped.
 */
export function moveOps(ids: readonly string[], map: PlacementMap): Op[] {
  const ops: Op[] = [];
  const moved = new Set(ids);
  const working = new Map<string, Placement>(map);
  const touchedFrames = new Set<string>();

  for (const id of topLevelOf(ids, map)) {
    const item = working.get(id);
    const rect = absoluteRect(id, working);
    if (!item || !rect) continue;
    const target = frameAt(center(rect), working, moved);
    let pos: XY = { x: item.x, y: item.y };
    if (target !== item.parent) {
      pos = toParentSpace(rect, target, working);
      ops.push({ op: 'update_node', id, patch: { parent: target ?? null } });
    }
    // No snapping here: React Flow already snapped the drag, and a reparented
    // node must land exactly where it was dropped.
    if (target !== undefined) {
      pos = clampIntoFrame(pos);
      touchedFrames.add(target);
    }
    ops.push({ op: 'move_node', id, view: { x: pos.x, y: pos.y, pinned: true } });
    const next: Placement = { ...item, ...pos };
    if (target === undefined) delete next.parent;
    else next.parent = target;
    working.set(id, next);
  }
  ops.push(...growOps(touchedFrames, working));
  return ops;
}

/** Move by a fixed offset (arrow-key nudging). */
export function nudgeOps(ids: readonly string[], dx: number, dy: number, map: PlacementMap): Op[] {
  const ops: Op[] = [];
  const working = new Map<string, Placement>(map);
  const parents = new Set<string>();
  for (const id of topLevelOf(ids, map)) {
    const item = map.get(id);
    if (!item) continue;
    let pos = { x: item.x + dx, y: item.y + dy };
    if (item.parent !== undefined) {
      pos = clampIntoFrame(pos);
      parents.add(item.parent);
    }
    ops.push({ op: 'move_node', id, view: { ...pos, pinned: true } });
    working.set(id, { ...item, ...pos });
  }
  ops.push(...growOps(parents, working));
  return ops;
}

/** Commit a frame resize. */
export function resizeOps(id: string, rect: Rect, map: PlacementMap): Op[] {
  const item = map.get(id);
  const view = {
    x: snap(rect.x),
    y: snap(rect.y),
    w: Math.max(FRAME_MIN.w, snapUp(rect.w)),
    h: Math.max(FRAME_MIN.h, snapUp(rect.h)),
    pinned: true,
  };
  const ops: Op[] = [{ op: 'move_node', id, view }];
  if (item?.parent !== undefined) {
    const working = new Map(map);
    working.set(id, { ...item, ...view });
    ops.push(...growOps([item.parent], working));
  }
  return ops;
}

// ── Removing ─────────────────────────────────────────────────────────────────

export type ChildrenMode = 'reparent' | 'cascade';

/**
 * Remove nodes and edges. With `cascade`, nodes inside a removed frame are
 * not removed separately (the frame takes them along). Edges that touch a
 * removed node go with it and are not removed twice.
 */
export function removeOps(
  nodeIds: readonly string[],
  edgeIds: readonly string[],
  edges: ReadonlyMap<string, BoardEdge>,
  map: PlacementMap,
  mode: ChildrenMode = 'reparent',
): Op[] {
  const ops: Op[] = [];
  const ids = mode === 'cascade' ? topLevelOf(nodeIds, map) : [...nodeIds];
  const removed = new Set(nodeIds);
  if (mode === 'cascade') {
    for (const item of map.values()) {
      if (ids.some((id) => item.id !== id && isInsideId(item.id, id, map))) removed.add(item.id);
    }
  }
  // Plain nodes first, then frames from the innermost out, so no op refers to something already gone.
  const ordered = [...ids].sort((a, b) => {
    const fa = map.get(a)?.frame ? 1 : 0;
    const fb = map.get(b)?.frame ? 1 : 0;
    return fa - fb || depthOf(b, map) - depthOf(a, map);
  });
  for (const id of ordered) {
    const op: Op = { op: 'remove_node', id };
    if (map.get(id)?.frame) op.children = mode;
    ops.push(op);
  }
  for (const id of edgeIds) {
    const edge = edges.get(id);
    if (!edge || removed.has(edge.source) || removed.has(edge.target)) continue;
    ops.push({ op: 'remove_edge', id });
  }
  return ops;
}

function isInsideId(id: string, frame: string, map: PlacementMap): boolean {
  const seen = new Set<string>([id]);
  let parent = map.get(id)?.parent;
  while (parent !== undefined && !seen.has(parent)) {
    if (parent === frame) return true;
    seen.add(parent);
    parent = map.get(parent)?.parent;
  }
  return false;
}

/** How many nodes sit inside `frame`, at any depth. */
export function countInside(frame: string, map: PlacementMap): number {
  let count = 0;
  for (const item of map.values()) if (isInsideId(item.id, frame, map)) count++;
  return count;
}

// ── Duplicating ──────────────────────────────────────────────────────────────

export const DUPLICATE_OFFSET = 24;

/**
 * Copy the selected nodes (and everything inside selected frames) with the
 * edges between them, offset down and to the right.
 */
export function duplicateOps(
  ids: readonly string[],
  nodes: ReadonlyMap<string, BoardNode>,
  edges: Iterable<BoardEdge>,
  map: PlacementMap,
  newId: (prefix: string) => string,
): { ops: Op[]; ids: string[] } {
  const top = topLevelOf(ids, map);
  const included = new Set(top);
  for (const item of map.values()) {
    if (top.some((id) => isInsideId(item.id, id, map))) included.add(item.id);
  }
  const order = [...included].sort((a, b) => depthOf(a, map) - depthOf(b, map));
  const idMap = new Map(order.map((id) => [id, newId('n')]));
  const topSet = new Set(top);
  const ops: Op[] = [];
  const parentsToGrow = new Set<string>();
  const working = new Map<string, Placement>(map);

  for (const id of order) {
    const node = nodes.get(id);
    const copyId = idMap.get(id);
    const placement = map.get(id);
    if (!node || !copyId || !placement) continue;
    const parent = node.parent !== undefined ? (idMap.get(node.parent) ?? node.parent) : undefined;
    const offset = topSet.has(id) ? DUPLICATE_OFFSET : 0;
    const view: View = {
      ...(node.view ?? {}),
      x: placement.x + offset,
      y: placement.y + offset,
      pinned: true,
    };
    if (node.type === 'frame') {
      view.w = placement.w;
      view.h = placement.h;
    }
    ops.push({
      op: 'add_node',
      id: copyId,
      node: {
        type: node.type,
        title: node.title,
        ...(node.body !== undefined ? { body: node.body } : {}),
        ...(node.status !== undefined ? { status: node.status } : {}),
        ...(node.tags !== undefined ? { tags: [...node.tags] } : {}),
        ...(node.props !== undefined ? { props: structuredClone(node.props) } : {}),
        ...(node.links !== undefined ? { links: node.links.map((l) => ({ ...l })) } : {}),
        ...(parent !== undefined ? { parent } : {}),
        view,
      },
    });
    const copy: Placement = { ...placement, id: copyId, x: view.x, y: view.y };
    if (parent === undefined) delete copy.parent;
    else copy.parent = parent;
    working.set(copyId, copy);
    if (topSet.has(id) && node.parent !== undefined) parentsToGrow.add(node.parent);
  }
  for (const edge of edges) {
    const source = idMap.get(edge.source);
    const target = idMap.get(edge.target);
    if (!source || !target) continue;
    ops.push({
      op: 'add_edge',
      id: newId('e'),
      edge: { type: edge.type, source, target, ...(edge.label ? { label: edge.label } : {}) },
    });
  }
  ops.push(...growOps(parentsToGrow, working));
  return { ops, ids: top.map((id) => idMap.get(id) as string) };
}

// ── Framing ──────────────────────────────────────────────────────────────────

/** Wrap the selection in a new frame, keeping every node where it is drawn. */
export function frameAroundOps(
  ids: readonly string[],
  map: PlacementMap,
  frameId: string,
  title = 'Frame',
): Op[] {
  const top = topLevelOf(ids, map);
  const rects = top.map((id) => absoluteRect(id, map)).filter((r): r is Rect => r !== undefined);
  const bounds = boundsOf(rects);
  if (!bounds) return [];
  const parent = commonFrame(top, map);
  const abs = {
    x: snap(bounds.x - FRAME_PADDING.left),
    y: snap(bounds.y - FRAME_PADDING.top),
  };
  const w = Math.max(FRAME_MIN.w, snapUp(bounds.x + bounds.w + FRAME_PADDING.right - abs.x));
  const h = Math.max(FRAME_MIN.h, snapUp(bounds.y + bounds.h + FRAME_PADDING.bottom - abs.y));
  const rel = toParentSpace(abs, parent, map);
  const ops: Op[] = [
    {
      op: 'add_node',
      id: frameId,
      node: {
        type: 'frame',
        title,
        ...(parent !== undefined ? { parent } : {}),
        view: { x: rel.x, y: rel.y, w, h, pinned: true },
      },
    },
  ];
  const working = new Map<string, Placement>(map);
  working.set(frameId, { id: frameId, ...rel, w, h, frame: true, ...(parent ? { parent } : {}) });
  for (const id of top) {
    const rect = absoluteRect(id, map);
    if (!rect) continue;
    ops.push({ op: 'update_node', id, patch: { parent: frameId } });
    ops.push({ op: 'move_node', id, view: { x: rect.x - abs.x, y: rect.y - abs.y } });
  }
  if (parent !== undefined) ops.push(...growOps([parent], working));
  return ops;
}
