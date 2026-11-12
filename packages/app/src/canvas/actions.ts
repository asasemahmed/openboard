/**
 * Everything a person can do to the board, shared by the canvas, keyboard
 * shortcuts, toolbar, inspector and command palette.
 */
import { type Actor, newId, type Op, type Status } from '@openboard/core';
import { useReactFlow } from '@xyflow/react';
import { createContext, useContext, useMemo } from 'react';
import { ApiError } from '../lib/api.js';
import {
  addNodeOps,
  type ChildrenMode,
  countInside,
  duplicateOps,
  frameAroundOps,
  nudgeOps,
  removeOps,
} from '../lib/commands.js';
import { DEFAULT_EDGE_TYPE } from '../lib/edgeTypes.js';
import type { XY } from '../lib/geometry.js';
import { typeMeta } from '../lib/nodeTypes.js';
import { useSession } from '../state/context.js';
import { types } from '../state/schema.js';
import type { BoardSession } from '../state/session.js';
import { toasts } from '../state/toasts.js';

export interface BoardActions {
  apply(ops: Op[]): boolean;
  addNode(type: string, at?: XY): string | null;
  deleteSelection(): void;
  duplicateSelection(): void;
  frameSelection(): void;
  nudge(dx: number, dy: number): void;
  setStatus(ids: readonly string[], status: Status | null): void;
  connect(source: string, target: string, type?: string): void;
  undo(): void;
  redo(): void;
  tidy(scope: 'unpinned' | 'all'): Promise<void>;
  jumpTo(nodeId: string): void;
  /** Select and bring into view nodes that are on their way (a template or import just added them). */
  reveal(nodeIds: readonly string[]): Promise<void>;
  fit(): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  editTitle(): void;
  /** Canvas point at the middle of the visible canvas. */
  viewCenter(): XY;
}

const DEFAULT_TITLES: Record<string, string> = {
  note: 'New note',
  task: 'New task',
  decision: 'New decision',
  question: 'New question',
  risk: 'New risk',
  doc: 'New doc',
  code: 'New code',
  agent: 'New agent',
  run: 'New run',
  frame: 'Frame',
};

export function describeErrors(outcome: { errors: Array<{ message: string }> }): string {
  const first = outcome.errors[0]?.message ?? 'The change was refused.';
  return outcome.errors.length > 1 ? `${first} (+${outcome.errors.length - 1} more)` : first;
}

export function applyOrReport(session: BoardSession, ops: Op[], actor: Actor = session.actor()) {
  if (ops.length === 0) return false;
  const outcome = session.store.apply(ops, actor);
  if (!outcome.ok) {
    toasts.show(`Could not save: ${describeErrors(outcome)}`, { tone: 'error' });
    return false;
  }
  return true;
}

export function useBoardActions(): BoardActions {
  const session = useSession();
  const flow = useReactFlow();

  return useMemo<BoardActions>(() => {
    const { store, ui, undo } = session;

    const viewCenter = (): XY => {
      const el = document.querySelector('.canvas-root');
      const rect = el?.getBoundingClientRect();
      if (!rect || rect.width === 0) return { x: 0, y: 0 };
      return flow.screenToFlowPosition({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
    };

    const apply = (ops: Op[]) => applyOrReport(session, ops);

    const removeWithMode = (
      nodeIds: readonly string[],
      edgeIds: readonly string[],
      mode: ChildrenMode,
    ) => {
      apply(removeOps(nodeIds, edgeIds, store.boardEdges(), store.placements(), mode));
    };

    const actions: BoardActions = {
      apply,
      viewCenter,

      addNode(type, at) {
        const id = newId('n');
        const meta = typeMeta(type);
        const declared = types.get().node.get(type);
        const custom = declared && declared.source !== 'builtin' ? declared : undefined;
        const point = at ?? ui.lastPointer ?? viewCenter();
        const ok = apply(
          addNodeOps(
            {
              id,
              type,
              title: DEFAULT_TITLES[type] ?? `New ${(custom?.label ?? meta.name).toLowerCase()}`,
              ...(meta.initialStatus && custom?.hasStatus !== false
                ? { status: meta.initialStatus }
                : {}),
              at: point,
              ...(custom && custom.fields.length > 0 ? { bodyRoom: true } : {}),
            },
            store.placements(),
          ),
        );
        if (!ok) return null;
        store.select([id]);
        ui.editing.set(id);
        return id;
      },

      deleteSelection() {
        const { nodeIds, edgeIds } = store.selection;
        if (nodeIds.length === 0 && edgeIds.length === 0) return;
        const map = store.placements();
        const framesWithChildren = nodeIds.filter(
          (id) => map.get(id)?.frame && countInside(id, map) > 0,
        );
        if (framesWithChildren.length === 0) {
          removeWithMode(nodeIds, edgeIds, 'reparent');
          return;
        }
        const inside = framesWithChildren.reduce((sum, id) => sum + countInside(id, map), 0);
        const single =
          framesWithChildren.length === 1 ? store.node(framesWithChildren[0] ?? '') : undefined;
        ui.confirm.set({
          title: single
            ? `Delete the frame “${single.title}”?`
            : `Delete ${framesWithChildren.length} frames?`,
          body: `${inside} item${inside === 1 ? ' is' : 's are'} inside. Keep them on the board, or delete them with the frame.`,
          actions: [
            { label: 'Cancel', run: () => {} },
            { label: 'Keep contents', run: () => removeWithMode(nodeIds, edgeIds, 'reparent') },
            {
              label: 'Delete everything',
              tone: 'danger',
              run: () => removeWithMode(nodeIds, edgeIds, 'cascade'),
            },
          ],
        });
      },

      duplicateSelection() {
        const ids = store.selection.nodeIds;
        if (ids.length === 0) return;
        const result = duplicateOps(
          ids,
          store.boardNodes(),
          store.boardEdges().values(),
          store.placements(),
          newId,
        );
        if (apply(result.ops)) store.select(result.ids);
      },

      frameSelection() {
        const ids = store.selection.nodeIds;
        if (ids.length === 0) {
          actions.addNode('frame');
          return;
        }
        const frameId = newId('n');
        if (apply(frameAroundOps(ids, store.placements(), frameId))) {
          store.select([frameId]);
          ui.editing.set(frameId);
        }
      },

      nudge(dx, dy) {
        const ids = store.selection.nodeIds;
        if (ids.length > 0) apply(nudgeOps(ids, dx, dy, store.placements()));
      },

      setStatus(ids, status) {
        const ops: Op[] = ids
          .filter((id) => store.node(id)?.type !== 'frame')
          .map((id) => ({ op: 'update_node', id, patch: { status } }) as Op);
        apply(ops);
      },

      connect(source, target, type = DEFAULT_EDGE_TYPE) {
        if (source === target) return;
        const exists = [...store.boardEdges().values()].some(
          (e) => e.type === type && e.source === source && e.target === target,
        );
        if (exists) {
          toasts.show('Those two are already connected that way.');
          return;
        }
        const id = newId('e');
        if (apply([{ op: 'add_edge', id, edge: { type, source, target } }])) store.select([], [id]);
      },

      undo() {
        if (!undo.undo()) toasts.show('Nothing to undo.');
      },

      redo() {
        if (!undo.redo()) toasts.show('Nothing to redo.');
      },

      async tidy(scope) {
        try {
          const result = await session.api.layout(session.boardId, { scope });
          toasts.show(
            result.moved === 0
              ? 'Already tidy.'
              : `Moved ${result.moved} node${result.moved === 1 ? '' : 's'}.`,
          );
        } catch (error) {
          const message =
            error instanceof ApiError && error.unreachable
              ? 'Tidy up needs the server, which is not reachable right now.'
              : `Tidy up failed: ${error instanceof Error ? error.message : String(error)}`;
          toasts.show(message, { tone: 'error' });
        }
      },

      jumpTo(nodeId) {
        if (!store.node(nodeId)) return;
        store.select([nodeId]);
        void flow.fitView({
          nodes: [{ id: nodeId }],
          duration: reducedMotion() ? 0 : 240,
          maxZoom: 1.25,
          padding: 0.4,
        });
      },

      async reveal(nodeIds) {
        if (nodeIds.length === 0) return;
        // The nodes come through the live document a moment after the request returns.
        for (let i = 0; i < 40 && !nodeIds.some((id) => store.node(id)); i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const present = nodeIds.filter((id) => store.node(id));
        if (present.length === 0) return;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        store.select(present);
        ui.pointAt(present);
        const pointed = ui.highlight.get();
        setTimeout(() => {
          if (ui.highlight.get() === pointed) ui.pointAt([]);
        }, 2400);
        void flow.fitView({
          nodes: present.map((id) => ({ id })),
          duration: reducedMotion() ? 0 : 240,
          maxZoom: 1,
          padding: 0.2,
        });
      },

      fit() {
        void flow.fitView({ duration: reducedMotion() ? 0 : 240, padding: 0.12, maxZoom: 1.25 });
      },
      zoomIn() {
        void flow.zoomIn({ duration: reducedMotion() ? 0 : 120 });
      },
      zoomOut() {
        void flow.zoomOut({ duration: reducedMotion() ? 0 : 120 });
      },
      resetZoom() {
        void flow.zoomTo(1, { duration: reducedMotion() ? 0 : 120 });
      },

      editTitle() {
        const [only, ...rest] = store.selection.nodeIds;
        if (only && rest.length === 0) ui.editing.set(only);
      },
    };
    return actions;
  }, [session, flow]);
}

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const ActionsContext = createContext<BoardActions | null>(null);

export const ActionsProvider = ActionsContext.Provider;

export function useActions(): BoardActions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error('useActions must be used inside an ActionsProvider');
  return actions;
}
