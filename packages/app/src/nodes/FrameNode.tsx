/**
 * A frame: a container drawn behind its children. Only the title bar picks
 * up the pointer (so the inside behaves like canvas: box-select, double-click
 * to add), and the frame is resizable while selected.
 */
import { FRAME_MIN, FRAME_PADDING } from '@openboard/core';
import { Handle, type NodeProps, NodeResizer, Position } from '@xyflow/react';
import { memo } from 'react';
import { useNodeFocus } from '../canvas/nodeFocus.js';
import { resizeOps } from '../lib/commands.js';
import type { FlowNode } from '../lib/flow.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { NodeDecorations } from './NodeDecorations.js';
import { TitleEditor, useIsEditing } from './TitleEditor.js';

/** "count,minW,minH" for a frame's children; a string so the hook result is a primitive. */
function useFrameContent(
  id: string,
  measure: boolean,
): { count: number; minW: number; minH: number } {
  const { store } = useSession();
  const key = useStoreValue(store, () => {
    let count = 0;
    let minW: number = FRAME_MIN.w;
    let minH: number = FRAME_MIN.h;
    for (const p of store.placements().values()) {
      if (p.parent !== id) continue;
      count++;
      if (measure) {
        minW = Math.max(minW, p.x + p.w + FRAME_PADDING.right);
        minH = Math.max(minH, p.y + p.h + FRAME_PADDING.bottom);
      }
    }
    return `${count},${minW},${minH}`;
  });
  const [count = 0, minW = FRAME_MIN.w, minH = FRAME_MIN.h] = key.split(',').map(Number);
  return { count, minW, minH };
}

const FRAME_HANDLES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

function FrameNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const session = useSession();
  const { node, ghost } = data;
  const editing = useIsEditing(id);
  const isDropTarget = useStoreValue(
    session.ui.dropTarget,
    () => session.ui.dropTarget.get() === id,
  );
  const { count, minW, minH } = useFrameContent(id, selected);
  const focus = useNodeFocus(id, ghost);

  return (
    <section
      className={`frame${selected ? ' is-selected' : ''}${isDropTarget ? ' is-drop-target' : ''}${ghost ? ' is-ghost' : ''}`}
      aria-label={`Frame: ${node.title}`}
      {...focus}
    >
      {!ghost && (
        <NodeResizer
          isVisible={selected}
          minWidth={minW}
          minHeight={minH}
          lineClassName="frame-resize-line"
          handleClassName="frame-resize-handle"
          onResizeEnd={(_event, params) => {
            const outcome = session.store.apply(
              resizeOps(
                id,
                { x: params.x, y: params.y, w: params.width, h: params.height },
                session.store.placements(),
              ),
              session.actor(),
            );
            if (!outcome.ok) session.store.resetTransient([id]);
          }}
        />
      )}
      {/* Edges need a handle to attach to; frames are not connected by dragging, so these stay hidden. */}
      {FRAME_HANDLES.map((position) => (
        <Handle
          key={position}
          id={position}
          type="source"
          position={position}
          isConnectable={false}
          className="frame-anchor"
        />
      ))}
      <header className="frame-titlebar frame-handle">
        {editing ? (
          <TitleEditor id={id} title={node.title} lines={1} className="frame-title" />
        ) : (
          <h3
            className="frame-title"
            onDoubleClick={(event) => {
              if (ghost) return;
              event.stopPropagation();
              session.ui.editing.set(id);
            }}
          >
            {node.title}
          </h3>
        )}
        <span
          className="frame-count"
          title={`${count} item${count === 1 ? '' : 's'} directly inside`}
        >
          {count}
        </span>
        <span className="frame-head-end">
          <NodeDecorations slot="header" node={node} ghost={ghost} />
        </span>
      </header>
      <NodeDecorations slot="overlay" node={node} ghost={ghost} />
    </section>
  );
}

export const FrameNode = memo(
  FrameNodeView,
  (a, b) =>
    a.data === b.data &&
    a.selected === b.selected &&
    a.width === b.width &&
    a.height === b.height &&
    a.dragging === b.dragging,
);
