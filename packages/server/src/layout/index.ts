/**
 * The layout engine: places nodes so that nobody editing a board through the
 * agent API has to think about coordinates.
 *
 * All functions are pure over plain `Board` JSON and return a `LayoutPatch`
 * (node id -> complete new view). Only nodes whose view changes are in it.
 *
 * Design notes:
 *
 * - Containers (the canvas and each frame) are laid out one at a time, from
 *   the deepest frame up. Each frame is sized to its finished content before
 *   its parent is arranged, where it is one box among its siblings. This is
 *   used instead of ELK's `INCLUDE_CHILDREN` hierarchy handling because
 *   pinned nodes, frame-scoped layouts, and incremental placement all work on
 *   one container while the rest of the board stays fixed, which a single
 *   whole-board ELK run cannot express.
 * - Edges between nodes in different frames are lifted to the closest
 *   container holding both ends and attached to the children of that
 *   container that contain each end. So an edge from a node in frame A to a
 *   node in frame B orders A and B among their siblings.
 * - Flow direction per edge type is defined by `orientEdge` (see
 *   `structure.ts`): `depends_on` and `implements` put their target upstream,
 *   every other type its source. `down` puts upstream above, `right` left.
 */
import type { Board, BoardNode } from '@openboard/core';
import type { Direction } from './elk.js';
import { arrangeContainer, makeRoom, placeEach, sizeFrame, Workspace } from './engine.js';
import { type LayoutPatch, nodeSize, type Rect } from './geometry.js';
import { bottomUp, buildStructure, frameSubtree, ROOT, type Structure } from './structure.js';

export type { Direction } from './elk.js';
export {
  absoluteRect,
  applyLayoutPatch,
  findOverlaps,
  frameSizeFor,
  type LayoutPatch,
  nodeSize,
  type Rect,
} from './geometry.js';
export { orientEdge, UPSTREAM_TARGET_EDGE_TYPES } from './structure.js';

export interface IncrementalOptions {
  direction?: Direction;
}

export interface FullOptions {
  /**
   * `unpinned` (default): pinned nodes keep their view, everything else is re-laid out.
   * `all`: everything is re-laid out and `pinned` is cleared.
   * Any other value is a frame id: only that frame's descendants and its size change.
   */
  scope?: 'unpinned' | 'all' | (string & {});
  direction?: Direction;
}

/**
 * A container is laid out from scratch rather than node by node when none of
 * its children has a view yet, or when at least this many new children
 * outnumber the placed ones three to one. Placed children still never move.
 */
const FRESH_BATCH = 4;

const isPinned = (node: BoardNode): boolean => node.view?.pinned === true;

function allContainers(structure: Structure): string[] {
  const frames = [...structure.children.keys()].filter((key) => key !== ROOT);
  return [...bottomUp(structure, frames), ROOT];
}

/**
 * Places only what needs placing; everything already placed stays exactly
 * where it is.
 *
 * Nodes without a view get one. Frames that no longer contain their children
 * grow (pinned ones too, keeping their position), and a grown frame pushes
 * unpinned siblings it now overlaps out of its way. Nothing else moves.
 */
export async function layoutIncremental(
  board: Board,
  opts: IncrementalOptions = {},
): Promise<LayoutPatch> {
  const structure = buildStructure(board);
  const ws = new Workspace(structure, opts.direction ?? 'down');
  const grown = new Map<string, Rect>();
  for (const container of allContainers(structure)) {
    makeRoom(ws, container, grown);
    const kids = ws.children(container);
    const fresh = kids.filter((kid) => !ws.views.has(kid.id));
    if (fresh.length > 0) {
      const placed = kids.length - fresh.length;
      if (placed === 0 || (fresh.length >= FRESH_BATCH && fresh.length >= 3 * placed)) {
        await arrangeContainer(ws, container, (node) => ws.views.has(node.id), false);
      } else {
        placeEach(ws, container, fresh);
      }
    }
    if (container !== ROOT) {
      const before = sizeFrame(ws, container, 'grow');
      if (before) grown.set(container, before);
    }
  }
  return ws.patch();
}

/** Re-arranges a scope from scratch. Throws when `scope` names something that is not a frame. */
export async function layoutFull(board: Board, opts: FullOptions = {}): Promise<LayoutPatch> {
  const scope = opts.scope ?? 'unpinned';
  const structure = buildStructure(board);
  const ws = new Workspace(structure, opts.direction ?? 'down');

  if (scope === 'all' || scope === 'unpinned') {
    const all = scope === 'all';
    for (const container of allContainers(structure)) {
      await arrangeContainer(ws, container, all ? () => false : isPinned, all);
      if (container !== ROOT) sizeFrame(ws, container, frameMode(board, container, all));
    }
    return ws.patch();
  }

  const frame = board.nodes[scope];
  if (!frame || frame.type !== 'frame') {
    throw new Error(`layout scope "${scope}" is not a frame on this board`);
  }
  for (const container of bottomUp(structure, frameSubtree(structure, scope))) {
    await arrangeContainer(ws, container, isPinned, false);
    sizeFrame(ws, container, frameMode(board, container, false));
  }
  // Containment holds at all times: if the frame grew, its ancestors grow to
  // match and make room exactly as they do for an incremental change.
  const grown = new Map<string, Rect>();
  const now = ws.rect(scope);
  if (frame.view && now) {
    const size = nodeSize(frame);
    if (now.w > size.w || now.h > size.h) {
      grown.set(scope, { x: frame.view.x, y: frame.view.y, w: size.w, h: size.h });
    }
  }
  let container = ws.containerOf(scope);
  while (grown.size > 0) {
    makeRoom(ws, container, grown);
    if (container === ROOT) break;
    const before = sizeFrame(ws, container, 'grow');
    if (!before) break;
    grown.set(container, before);
    container = ws.containerOf(container);
  }
  return ws.patch();
}

/** Frames fit their content exactly, except pinned frames, which only grow (unless pinning is being cleared). */
function frameMode(board: Board, frameId: string, ignorePins: boolean): 'fit' | 'grow' {
  const frame = board.nodes[frameId];
  return !ignorePins && frame && isPinned(frame) ? 'grow' : 'fit';
}
