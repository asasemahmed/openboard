/**
 * The one edge component. Endpoints float to the facing sides of the two
 * nodes; type is shown by dash, end marker and a small mono label.
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
import { edgeMeta } from '../lib/edgeTypes.js';
import type { FlowEdge } from '../lib/flow.js';
import { useSession } from '../state/context.js';
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

function BoardEdgeView({ id, source, target, data, selected }: EdgeProps<FlowEdge>) {
  const { store } = useSession();
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode || !data) return null;

  const edge = data.edge;
  const ghost = data.ghost;
  const meta = edgeMeta(edge.type);
  const ends = edgeEnds(rectOf(sourceNode), rectOf(targetNode));
  const [path, labelX, labelY] = getBezierPath({
    sourceX: ends.sx,
    sourceY: ends.sy,
    sourcePosition: POSITION[ends.sourceSide],
    targetX: ends.tx,
    targetY: ends.ty,
    targetPosition: POSITION[ends.targetSide],
  });
  const tone: MarkerTone = ghost || selected ? 'accent' : meta.tone;
  const dash = ghost ? '6 5' : meta.dash;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerUrl(meta.marker, tone)}
        interactionWidth={18}
        className={`board-edge edge-${meta.tone}${selected ? ' is-selected' : ''}${ghost ? ' is-ghost' : ''}`}
        style={{
          stroke: `var(--edge-${tone})`,
          strokeWidth: selected ? meta.width + 0.75 : meta.width,
          ...(dash ? { strokeDasharray: dash } : {}),
        }}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`edge-label nodrag nopan${selected ? ' is-selected' : ''}${ghost ? ' is-ghost' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          aria-label={`${meta.label} edge${edge.label ? `: ${edge.label}` : ''}`}
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
