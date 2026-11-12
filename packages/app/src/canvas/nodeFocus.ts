/**
 * Keyboard access to nodes. Cards and frames are focusable, with one tab
 * stop for the whole canvas (the selected node, else the first in reading
 * order), so Tab enters the board once and leaves it after the last node:
 *
 *   Tab / Shift+Tab   next / previous node in reading order
 *   Alt+arrow         nearest node in that direction
 *   Enter             edit the focused node's title
 *
 * React Flow's own keyboard handling stays off: it moves nodes with the
 * arrow keys, which the board already uses for nudging.
 */
import { type FocusEvent, type KeyboardEvent, type MouseEvent, useCallback } from 'react';
import type { PlacementMap } from '../lib/geometry.js';
import {
  type Direction,
  neighborInDirection,
  readingOrder,
  stepInOrder,
} from '../lib/keyboardNav.js';
import type { BoardStore, Selection } from '../state/boardStore.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { openReview } from '../state/review.js';

const orderCache = new WeakMap<PlacementMap, string[]>();

export function orderOf(store: BoardStore): string[] {
  const map = store.placements();
  let order = orderCache.get(map);
  if (!order) {
    order = readingOrder(map);
    orderCache.set(map, order);
  }
  return order;
}

let stopCache: { map: PlacementMap; selection: Selection; id: string | null } | null = null;

/** The one node that Tab reaches from outside the canvas. */
export function tabStopOf(store: BoardStore): string | null {
  const map = store.placements();
  const selection = store.selection;
  if (stopCache && stopCache.map === map && stopCache.selection === selection) return stopCache.id;
  const order = orderOf(store);
  const selected = new Set(selection.nodeIds);
  const id = order.find((n) => selected.has(n)) ?? order[0] ?? null;
  stopCache = { map, selection, id };
  return id;
}

function nodeElement(id: string): HTMLElement | null {
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
  return document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${escaped}"] [data-node-focus]`,
  );
}

/**
 * Focus a node's card. Nodes outside the view are not rendered, so this
 * waits a few frames for it to appear after the view has moved there.
 */
export function focusNodeElement(id: string, tries = 12): void {
  const el = nodeElement(id);
  if (el) {
    el.focus({ preventScroll: true });
    return;
  }
  if (tries > 0 && typeof requestAnimationFrame === 'function')
    requestAnimationFrame(() => focusNodeElement(id, tries - 1));
}

/**
 * Ghosts are not part of the board's tab order, but each is its own stop
 * (proposals are few and are what needs attention): Enter, Space or a click
 * opens the review of the proposal that adds it.
 */
function useGhostFocus(id: string, ghost: boolean) {
  const session = useSession();
  const open = useCallback(() => {
    const owner = session.store.review().ghostOwner.get(id);
    openReview(session, owner);
  }, [session, id]);
  if (!ghost) return null;
  // In a read-only view (a comparison) ghosts are pictures of the past, not proposals.
  if (session.ui.readOnly) return {};
  return {
    tabIndex: 0,
    role: 'button',
    'data-ghost-focus': '',
    onClick: (event: MouseEvent) => {
      event.stopPropagation();
      open();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    },
  };
}

/** Props that make a card or frame focusable as part of the canvas's single tab stop. */
export function useNodeFocus(id: string, ghost: boolean) {
  const ghostProps = useGhostFocus(id, ghost);
  const { store } = useSession();
  const isStop = useStoreValue(store, () => !ghost && tabStopOf(store) === id);
  const onFocus = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      // A click selects through React Flow (and may be extending a selection);
      // only keyboard focus selects here.
      let keyboard = false;
      try {
        keyboard = event.currentTarget.matches(':focus-visible');
      } catch {
        keyboard = false;
      }
      if (keyboard && !store.selection.nodeIds.includes(id)) store.select([id]);
    },
    [store, id],
  );
  if (ghostProps) return ghostProps;
  return { tabIndex: isStop ? 0 : -1, 'data-node-focus': '', onFocus };
}

const DIRECTIONS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

/**
 * Key handling for a focused node, attached to the canvas root. `reveal`
 * selects the node and brings it into view; the node is focused after.
 */
export function useNodeKeyboard(reveal: (id: string) => void) {
  const session = useSession();
  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      if (!target.hasAttribute?.('data-node-focus')) return;
      const id = target.closest('.react-flow__node')?.getAttribute('data-id');
      if (!id || event.metaKey || event.ctrlKey) return;
      const { store, ui } = session;
      let next: string | undefined;
      if (event.key === 'Tab' && !event.altKey) {
        next = stepInOrder(orderOf(store), id, event.shiftKey ? -1 : 1);
        // Past the last (or first) node, Tab leaves the canvas as usual.
        if (!next) return;
      } else if (event.altKey && !event.shiftKey && DIRECTIONS[event.key]) {
        next = neighborInDirection(id, DIRECTIONS[event.key] as Direction, store.placements());
        event.preventDefault();
        if (!next) return;
      } else if (event.key === 'Enter' && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        store.select([id]);
        ui.editing.set(id);
        return;
      } else return;
      event.preventDefault();
      reveal(next);
      focusNodeElement(next);
    },
    [session, reveal],
  );
}
