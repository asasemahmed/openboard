/**
 * The one edge component. Endpoints float to the facing sides of the two
 * nodes; type is shown by dash, end marker and a small mono label. An edge
 * that would run under another card takes a step path around it instead
 * (see `lib/edgeRoute.ts`).
 */
import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  type InternalNode,
  Position,
  useInternalNode,
} from '@xyflow/react';
import { memo } from 'react';
import { edgeEnds, type Side } from '../lib/edgeGeometry.js';
import { chooseRoute, detourPath, parseRouteKey, routeKey } from '../lib/edgeRoute.js';
import { edgeMeta } from '../lib/edgeTypes.js';
import type { FlowEdge } from '../lib/flow.js';
import { absoluteRect, type PlacementMap, type Rect } from '../lib/geometry.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { useTypes } from '../state/schema.js';
import { type MarkerTone, markerUrl } from './EdgeMarkers.js';

const POSITION: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

function rectOf(node: InternalNode) {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    w: node.measured.width ?? node.width ?? 0,
    h: node.measured.height ?? node.height ?? 0,
  };
}

interface Obstacles {
  rects: Map<string, Rect>;
  cards: Array<{ id: string; rect: Rect }>;
}

/** Absolute rects per placement snapshot, shared by every edge. */
const obstacleCache = new WeakMap<PlacementMap, Obstacles>();

function obstaclesOf(map: PlacementMap): Obstacles {
  let cached = obstacleCache.get(map);
  if (!cached) {
    const rects = new Map<string, Rect>();
    const cards: Obstacles['cards'] = [];
    for (const item of map.values()) {
      const rect = absoluteRect(item.id, map);
      if (!rect) continue;
      rects.set(item.id, rect);
      // Frames are containers, not obstacles: edges cross into them all the time.
      if (!item.frame) cards.push({ id: item.id, rect });
    }
    cached = { rects, cards };
    obstacleCache.set(map, cached);
  }
  return cached;
}

/** How this edge is drawn, as a primitive so the edge re-renders only when its route changes. */
function useRouteKey(source: string, target: string, enabled: boolean): string {
  const { store } = useSession();
  return useStoreValue(store, () => {
    if (!enabled) return 'curve';
    const { rects, cards } = obstaclesOf(store.placements());
    const s = rects.get(source);
    const t = rects.get(target);
    if (!s || !t) return 'curve';
    const others: Rect[] = [];
    for (const card of cards) if (card.id !== source && card.id !== target) others.push(card.rect);
    return routeKey(chooseRoute(s, t, others));
  });
}

function BoardEdgeView({ id, source, target, data, selected }: EdgeProps<FlowEdge>) {
  const { store, activity } = useSession();
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const ghost = data?.ghost ?? false;
  const route = parseRouteKey(useRouteKey(source, target, !ghost));
  const recent = useStoreValue(activity, () => activity.highlightFor('edge', id));
  const proposed = useStoreValue(store, () =>
    ghost ? undefined : store.review().edgeMarks.get(id)?.kind,
  );
  const declared = useTypes().edge;
  if (!sourceNode || !targetNode || !data) return null;

  const edge = data.edge;
  const meta = edgeMeta(edge.type, declared.get(edge.type));
  const from = rectOf(sourceNode);
  const to = rectOf(targetNode);
  let path: string;
  let labelX: number;
  let labelY: number;
  if (route.kind === 'detour') {
    ({ path, labelX, labelY } = detourPath(from, to, route));
  } else {
    const ends = edgeEnds(from, to);
    [path, labelX, labelY] = getBezierPath({
      sourceX: ends.sx,
      sourceY: ends.sy,
      sourcePosition: POSITION[ends.sourceSide],
      targetX: ends.tx,
      targetY: ends.ty,
      targetPosition: POSITION[ends.targetSide],
    });
  }
  const tone: MarkerTone = ghost || selected ? 'accent' : meta.tone;
  const dash = ghost ? '6 5' : meta.dash;
  const recentClass = `${recent ? ' is-recent' : ''}${
    proposed === 'remove'
      ? ' is-removal-proposed'
      : proposed === 'update'
        ? ' is-change-proposed'
        : ''
  }`;
  const recentStyle = recent ? { ['--recent-ms' as string]: `${recent.until - recent.at}ms` } : {};

  return (
    <>
      <BaseEdge
        key={recent?.at ?? 'edge'}
        id={id}
        path={path}
        markerEnd={markerUrl(meta.marker, tone)}
        interactionWidth={18}
        className={`board-edge edge-${meta.tone}${selected ? ' is-selected' : ''}${ghost ? ' is-ghost' : ''}${recentClass}`}
        style={{
          stroke: `var(--edge-${tone})`,
          strokeWidth: selected ? meta.width + 0.75 : meta.width,
          ...(dash ? { strokeDasharray: dash } : {}),
          ...recentStyle,
        }}
      />
      <EdgeLabelRenderer>
        <button
          key={recent?.at ?? 'label'}
          type="button"
          className={`edge-label nodrag nopan${selected ? ' is-selected' : ''}${ghost ? ' is-ghost' : ''}${recentClass}`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            ...recentStyle,
          }}
          aria-label={`${ghost ? 'Proposed ' : ''}${meta.label} edge${edge.label ? `: ${edge.label}` : ''}${proposed === 'remove' ? ' (removal proposed)' : ''}`}
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            if (!ghost) store.select([], [id]);
          }}
        >
          <span className="edge-label-type">{meta.label}</span>
          {edge.label && <span className="edge-label-text">{edge.label}</span>}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

export const BoardEdge = memo(BoardEdgeView);
