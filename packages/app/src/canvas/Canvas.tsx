/**
 * The canvas. React Flow is fully controlled by the BoardStore: the store
 * hands it nodes and edges, and React Flow hands back drags, measurements and
 * selection. Drags are written to the document once, on drop.
 */
import { GRID } from '@openboard/core';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  type FinalConnectionState,
  MiniMap,
  type OnConnect,
  type OnNodeDrag,
  ReactFlow,
  SelectionMode,
  useReactFlow,
} from '@xyflow/react';
import { type MouseEvent, useCallback } from 'react';
import { moveOps } from '../lib/commands.js';
import type { FlowEdge, FlowNode } from '../lib/flow.js';
import { absoluteRect, center, frameAt } from '../lib/geometry.js';
import { typeMeta } from '../lib/nodeTypes.js';
import { useTheme } from '../lib/theme.js';
import { CardNode } from '../nodes/CardNode.js';
import { FrameNode } from '../nodes/FrameNode.js';
import { useSession } from '../state/context.js';
import { useStoreValue, useValue } from '../state/emitter.js';
import { applyOrReport, type BoardActions } from './actions.js';
import { BoardEdge } from './BoardEdge.js';
import { Cursors } from './Cursors.js';
import { EdgeMarkers } from './EdgeMarkers.js';
import { EmptyBoard } from './EmptyBoard.js';
import { ZoomControls } from './ZoomControls.js';

const nodeTypes = { card: CardNode, frame: FrameNode };
const edgeTypes = { board: BoardEdge };
const PAN_BUTTONS = [1, 2];
const FIT_OPTIONS = { padding: 0.15, maxZoom: 1 };

export interface CanvasProps {
  actions: BoardActions;
  /** Off in tests, where jsdom has no layout to cull against. */
  onlyRenderVisibleElements?: boolean;
}

export function Canvas({ actions, onlyRenderVisibleElements = true }: CanvasProps) {
  const session = useSession();
  const { store, ui, presence } = session;
  const nodes = useStoreValue(store, store.getNodes);
  const edges = useStoreValue(store, store.getEdges);
  const minimap = useValue(ui.minimap);
  const { resolved } = useTheme();
  const flow = useReactFlow();

  const dropTargetFor = useCallback(
    (dragged: readonly FlowNode[], primary: FlowNode): string | undefined => {
      const map = store.placements();
      const rect = absoluteRect(primary.id, map);
      if (!rect) return undefined;
      return frameAt(center(rect), map, new Set(dragged.map((n) => n.id)));
    },
    [store],
  );

  const onNodeDrag: OnNodeDrag<FlowNode> = useCallback(
    (_event, node, dragged) => {
      const target = dropTargetFor(dragged, node);
      // Highlight only when dropping here would move the node into a different frame.
      ui.dropTarget.set(target !== undefined && target !== node.parentId ? target : null);
    },
    [dropTargetFor, ui],
  );

  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback(
    (_event, _node, dragged) => {
      ui.dropTarget.set(null);
      const ids = dragged.map((n) => n.id);
      if (ids.length === 0) return;
      const ok = applyOrReport(session, moveOps(ids, store.placements()));
      if (!ok) store.resetTransient(ids);
    },
    [session, store, ui],
  );

  const onConnect: OnConnect = useCallback(
    (connection) => actions.connect(connection.source, connection.target),
    [actions],
  );

  // Dropping a connection anywhere on a card (not only on a handle) connects to it.
  const onConnectEnd = useCallback(
    (event: globalThis.MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid || !state.fromNode) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (!point) return;
      const el = document.elementFromPoint(point.clientX, point.clientY);
      const target = el?.closest('.react-flow__node')?.getAttribute('data-id');
      if (target && target !== state.fromNode.id) actions.connect(state.fromNode.id, target);
    },
    [actions],
  );

  const onNodeDoubleClick = useCallback(
    (event: MouseEvent, node: FlowNode) => {
      if (node.data.ghost || (event.target as HTMLElement).closest('.title-editor')) return;
      ui.editing.set(node.id);
    },
    [ui],
  );

  const toCanvas = useCallback(
    (event: MouseEvent) => flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    [flow],
  );

  const onDoubleClick = useCallback(
    (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.classList.contains('react-flow__pane')) return;
      actions.addNode('note', toCanvas(event));
    },
    [actions, toCanvas],
  );

  const onMouseMove = useCallback(
    (event: MouseEvent) => {
      const point = toCanvas(event);
      ui.lastPointer = point;
      presence.setCursor(point);
    },
    [toCanvas, ui, presence],
  );

  const onMouseLeave = useCallback(() => {
    ui.lastPointer = null;
    presence.setCursor(null);
  }, [ui, presence]);

  return (
    <div className="canvas-root">
      <EdgeMarkers />
      <ReactFlow<FlowNode, FlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={store.onNodesChange}
        onEdgesChange={store.onEdgesChange}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onNodeDoubleClick={onNodeDoubleClick}
        onDoubleClick={onDoubleClick}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={28}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={PAN_BUTTONS}
        panOnScroll
        zoomOnDoubleClick={false}
        snapToGrid
        snapGrid={[GRID, GRID]}
        nodeDragThreshold={2}
        onlyRenderVisibleElements={onlyRenderVisibleElements}
        zIndexMode="auto"
        elevateEdgesOnSelect
        disableKeyboardA11y
        minZoom={0.1}
        maxZoom={2.5}
        fitView
        fitViewOptions={FIT_OPTIONS}
        colorMode={resolved}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1.3}
          color="var(--dot)"
          bgColor="var(--canvas)"
        />
        <Cursors />
        <ZoomControls actions={actions} />
        {minimap && (
          <MiniMap<FlowNode>
            position="bottom-right"
            pannable
            zoomable
            ariaLabel="Mini map"
            nodeClassName={(node) => `minimap-node tone-${typeMeta(node.data.node.type).tone}`}
            nodeBorderRadius={4}
            maskColor="var(--minimap-mask)"
            bgColor="var(--card)"
          />
        )}
      </ReactFlow>
      {nodes.length === 0 && <EmptyBoard actions={actions} />}
    </div>
  );
}
