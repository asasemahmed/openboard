import { defaultNodeSize, type Op, type Status, snap, type View } from '@openboard-dev/core';
import {
  frameAt,
  framesToGrow,
  landingInFrame,
  type PlacementMap,
  toParentSpace,
  type XY,
} from './geometry.js';

export interface PastedCard {
  type: 'note' | 'task';
  title: string;
  status?: Status;
}

export const PASTE_CONFIRM_THRESHOLD = 50;
const COLUMN_GAP = 16;

/** Parse plain text into one card per non-empty line, stripping list markers. */
export function parsePastedLines(text: string): PastedCard[] {
  const cards: PastedCard[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const checkbox = /^(?:[-*]\s+)?\[([ xX])\]\s+(.+)$/.exec(trimmed);
    if (checkbox) {
      const title = checkbox[2]?.trim();
      if (title) {
        cards.push({
          type: 'task',
          title,
          status: checkbox[1] === ' ' ? 'todo' : 'done',
        });
      }
      continue;
    }

    const bullet = /^(?:[-*]|\d+[.)])\s+(.+)$/.exec(trimmed);
    if (bullet) {
      const title = bullet[1]?.trim();
      if (title) cards.push({ type: 'note', title });
      continue;
    }

    cards.push({ type: 'note', title: trimmed });
  }
  return cards;
}

/** Build a single batch of `add_node` ops laid out in a column at `at`. */
export function pasteLinesOps(
  cards: readonly PastedCard[],
  at: XY,
  map: PlacementMap,
  nextId: () => string,
): { ops: Op[]; ids: string[] } {
  const ops: Op[] = [];
  const ids: string[] = [];
  const working = new Map(map);
  const grownFrames = new Set<string>();
  let yOffset = 0;

  for (const card of cards) {
    const id = nextId();
    const size = defaultNodeSize({
      type: card.type,
      title: card.title,
      ...(card.status ? { status: card.status } : {}),
    });
    const centerPoint = { x: at.x, y: at.y + yOffset };
    const parent = frameAt(centerPoint, working);
    let pos = toParentSpace(
      { x: centerPoint.x - size.w / 2, y: centerPoint.y - size.h / 2 },
      parent,
      working,
    );
    pos = { x: snap(pos.x), y: snap(pos.y) };
    if (parent !== undefined) {
      pos = landingInFrame({ ...pos, ...size }, parent, working);
      grownFrames.add(parent);
    }
    const view: View = { x: pos.x, y: pos.y, pinned: true };
    ops.push({
      op: 'add_node',
      id,
      node: {
        type: card.type,
        title: card.title,
        ...(card.status ? { status: card.status } : {}),
        ...(parent !== undefined ? { parent } : {}),
        view,
      },
    });
    working.set(id, { id, parent, ...pos, ...size, frame: false });
    ids.push(id);
    yOffset += size.h + COLUMN_GAP;
  }

  for (const [frameId, size] of framesToGrow(grownFrames, working)) {
    ops.push({
      op: 'move_node',
      id: frameId,
      view: { w: Math.ceil(size.w / 8) * 8, h: Math.ceil(size.h / 8) * 8 },
    });
  }

  return { ops, ids };
}
