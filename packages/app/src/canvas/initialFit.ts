/**
 * The first fit of a board. React Flow's own `fitView` prop fits once, as soon
 * as the nodes are known, at whatever size the canvas has then. A browser pane
 * or window that is still opening lays the page out before it has a size of its
 * own, so that fit lands at the smallest zoom against a sliver of a canvas, and
 * nothing fits again when the window gets its real size. This fit waits until
 * both the window and the canvas have a size.
 */
import { type FitViewOptions, useReactFlow, useStoreApi } from '@xyflow/react';
import { useEffect } from 'react';
import type { FlowEdge, FlowNode } from '../lib/flow.js';

export interface Size {
  width: number;
  height: number;
}

/** Whether a fit made now would fit the canvas the person will see. */
export function readyToFit(canvas: Size, view: Size): boolean {
  return canvas.width > 0 && canvas.height > 0 && view.width > 0 && view.height > 0;
}

/** Fits the board once, as soon as the window and the canvas have a size. */
export function useInitialFit(options: FitViewOptions, onFirstFit?: () => boolean): void {
  const flow = useReactFlow<FlowNode, FlowEdge>();
  const flowStore = useStoreApi<FlowNode, FlowEdge>();

  useEffect(() => {
    let done = false;
    let stop = () => {};
    const tryFit = () => {
      if (done) return;
      const { width, height, panZoom } = flowStore.getState();
      const view = { width: window.innerWidth, height: window.innerHeight };
      if (!panZoom || !readyToFit({ width, height }, view)) return;
      done = true;
      stop();
      if (!onFirstFit?.()) void flow.fitView(options);
    };
    // React Flow measures the canvas whenever it resizes, which updates its store.
    const unsubscribe = flowStore.subscribe(tryFit);
    window.addEventListener('resize', tryFit);
    stop = () => {
      unsubscribe();
      window.removeEventListener('resize', tryFit);
    };
    tryFit();
    return () => stop();
  }, [flow, flowStore, options, onFirstFit]);
}
