/**
 * Shared geometry. The layout engine and the canvas both size nodes with these
 * numbers, so that a layout computed on the server does not overlap once the
 * browser renders it.
 *
 * Coordinates: a node's `view.x` / `view.y` are relative to the top-left corner
 * of its parent frame, or to the canvas origin when it has no parent. Moving a
 * frame therefore moves its children without rewriting them.
 */
import type { NodeInput } from './schema.js';

export const GRID = 8;
export const NODE_WIDTH = 264;
export const FRAME_MIN = { w: 328, h: 200 } as const;
/** Space a frame keeps between its border and its children. `top` leaves room for the title. */
export const FRAME_PADDING = { top: 56, right: 32, bottom: 32, left: 32 } as const;
/** Gaps the layout engine leaves between sibling nodes. */
export const NODE_GAP = { x: 48, y: 40 } as const;

export interface Size {
  w: number;
  h: number;
}

/**
 * The size a node is rendered at when its view does not say otherwise.
 * The canvas clamps content to match: two title lines, two body lines, one
 * row of status, tags, and links.
 */
export function defaultNodeSize(
  node: Pick<NodeInput, 'type' | 'title' | 'body' | 'status' | 'tags' | 'links'>,
): Size {
  if (node.type === 'frame') return { ...FRAME_MIN };
  let h = 40; // vertical padding plus the type label row
  h += node.title.length > 28 ? 48 : 24; // one or two title lines
  if (node.body?.trim()) h += 48; // two-line body preview
  if (node.status || node.tags?.length || node.links?.length) h += 32; // meta row
  return { w: NODE_WIDTH, h: snap(h) };
}

/** Round to the canvas grid. */
export function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}
