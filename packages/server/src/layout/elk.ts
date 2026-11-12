/**
 * Thin wrapper around ELK's layered algorithm for one container at a time.
 */
import { NODE_GAP, snap } from '@openboard/core';
import ElkModule from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import { cmp, type Size } from './geometry.js';

export type Direction = 'down' | 'right';

// The bundled build runs ELK in-process (no web worker). It is a CommonJS
// module whose export is the constructor and also carries it as `default`,
// which is how its typings describe it under NodeNext resolution.
const elk = new ElkModule.default();

/** Graph id for the root; `#` cannot appear in a node id. */
const GRAPH_ID = '#graph';

function layoutOptions(direction: Direction): Record<string, string> {
  const down = direction === 'down';
  // In layered layout, `nodeNode` is the gap between nodes in one layer and
  // `nodeNodeBetweenLayers` the gap between layers, so the axes swap with direction.
  const inLayer = down ? NODE_GAP.x : NODE_GAP.y;
  const betweenLayers = down ? NODE_GAP.y : NODE_GAP.x;
  return {
    'elk.algorithm': 'layered',
    'elk.direction': down ? 'DOWN' : 'RIGHT',
    'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    'elk.spacing.nodeNode': String(inLayer),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(betweenLayers),
    // Disconnected components are packed into rows by ELK's component
    // placer; keep at least one full gap between them on either axis.
    'elk.separateConnectedComponents': 'true',
    'elk.spacing.componentComponent': String(Math.max(NODE_GAP.x, NODE_GAP.y)),
    'elk.randomSeed': '1',
  };
}

export interface ArrangeItem extends Size {
  id: string;
}

/**
 * Lays out `items` with `edges` (`[upstream, downstream]` pairs; pairs that
 * mention an id not in `items` are ignored). Returns top-left positions
 * relative to the block's own top-left corner, snapped to the grid.
 *
 * Inputs are sorted first so the same set always yields the same result.
 */
export async function arrangeWithElk(
  items: readonly ArrangeItem[],
  edges: ReadonlyArray<readonly [string, string]>,
  direction: Direction,
): Promise<Map<string, { x: number; y: number }>> {
  const result = new Map<string, { x: number; y: number }>();
  if (items.length === 0) return result;
  const sorted = [...items].sort((a, b) => cmp(a.id, b.id));
  if (sorted.length === 1 && sorted[0]) {
    result.set(sorted[0].id, { x: 0, y: 0 });
    return result;
  }
  const known = new Set(sorted.map((item) => item.id));
  const elkEdges: ElkExtendedEdge[] = [];
  const seen = new Set<string>();
  for (const [up, down] of edges) {
    if (up === down || !known.has(up) || !known.has(down)) continue;
    const key = `${up}\u0000${down}`;
    if (seen.has(key)) continue;
    seen.add(key);
    elkEdges.push({ id: '', sources: [up], targets: [down] });
  }
  elkEdges.sort(
    (a, b) =>
      cmp(a.sources[0] ?? '', b.sources[0] ?? '') || cmp(a.targets[0] ?? '', b.targets[0] ?? ''),
  );
  elkEdges.forEach((edge, i) => {
    edge.id = `#e${i}`;
  });

  const graph: ElkNode = {
    id: GRAPH_ID,
    layoutOptions: layoutOptions(direction),
    children: sorted.map((item) => ({ id: item.id, width: item.w, height: item.h })),
    edges: elkEdges,
  };
  const laidOut = await elk.layout(graph);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const child of laidOut.children ?? []) {
    minX = Math.min(minX, child.x ?? 0);
    minY = Math.min(minY, child.y ?? 0);
  }
  for (const child of laidOut.children ?? []) {
    // Gaps are at least NODE_GAP (a multiple of the grid's size and far larger
    // than half a cell), so rounding each corner cannot create an overlap.
    result.set(child.id, { x: snap((child.x ?? 0) - minX), y: snap((child.y ?? 0) - minY) });
  }
  return result;
}
