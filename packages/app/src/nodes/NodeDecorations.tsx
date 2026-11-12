import type { BoardNode } from '@openboard/core';
import { type DecorationSlot, decorationsFor } from './decorations.js';

/** Renders every registered decoration for one slot of one node. */
export function NodeDecorations({
  slot,
  node,
  ghost,
}: {
  slot: DecorationSlot;
  node: BoardNode;
  ghost: boolean;
}) {
  const list = decorationsFor(slot);
  if (list.length === 0) return null;
  return (
    <>
      {list.map((d) =>
        d.applies && !d.applies(node, ghost) ? null : (
          <d.Component key={d.id} node={node} ghost={ghost} />
        ),
      )}
    </>
  );
}
