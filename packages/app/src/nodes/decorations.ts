/**
 * Node decorations: small, independent things drawn on a card or frame
 * without the card knowing about them (the pin, other people's selection,
 * and later an agent's run status or a proposal's review state).
 *
 * Slots:
 *   header   inline, at the end of the type-label row
 *   overlay  absolutely positioned over the whole node
 *
 * Register at startup, before the canvas mounts.
 */
import type { BoardNode } from '@openboard/core';
import type { ComponentType } from 'react';

export type DecorationSlot = 'header' | 'overlay';

export interface DecorationProps {
  node: BoardNode;
  /** True for nodes in the ghost layer (not on the board yet). */
  ghost: boolean;
}

export interface NodeDecoration {
  id: string;
  slot: DecorationSlot;
  /** Lower comes first. */
  order?: number;
  applies?: (node: BoardNode, ghost: boolean) => boolean;
  Component: ComponentType<DecorationProps>;
}

const registry: NodeDecoration[] = [];
const bySlot = new Map<DecorationSlot, NodeDecoration[]>();

export function registerNodeDecoration(decoration: NodeDecoration): () => void {
  const existing = registry.findIndex((d) => d.id === decoration.id);
  if (existing >= 0) registry.splice(existing, 1);
  registry.push(decoration);
  bySlot.clear();
  return () => {
    const index = registry.indexOf(decoration);
    if (index >= 0) registry.splice(index, 1);
    bySlot.clear();
  };
}

export function decorationsFor(slot: DecorationSlot): readonly NodeDecoration[] {
  let list = bySlot.get(slot);
  if (!list) {
    list = registry.filter((d) => d.slot === slot).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    bySlot.set(slot, list);
  }
  return list;
}
