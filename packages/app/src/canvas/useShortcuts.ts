/**
 * Board keyboard shortcuts. One window listener; nothing fires while the
 * person is typing in a field, or while a dialog, menu or the palette is open
 * (they handle their own keys).
 */
import { GRID } from '@openboard/core';
import { useEffect } from 'react';
import { isTypingTarget, matchesShortcut } from '../lib/shortcuts.js';
import { useSession } from '../state/context.js';
import type { BoardActions } from './actions.js';

export interface ShortcutDef {
  keys: string[];
  label: string;
  group: 'Create' | 'Edit' | 'Select' | 'View';
}

/** What the shortcuts sheet lists. */
export const SHORTCUTS: ShortcutDef[] = [
  { keys: ['n'], label: 'New note at the pointer', group: 'Create' },
  { keys: ['t'], label: 'New task at the pointer', group: 'Create' },
  { keys: ['f'], label: 'Frame around the selection', group: 'Create' },
  { keys: ['mod+d'], label: 'Duplicate', group: 'Create' },
  { keys: ['enter'], label: 'Edit title', group: 'Edit' },
  { keys: ['backspace', 'delete'], label: 'Delete', group: 'Edit' },
  { keys: ['mod+z'], label: 'Undo', group: 'Edit' },
  { keys: ['shift+mod+z'], label: 'Redo', group: 'Edit' },
  {
    keys: ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'],
    label: 'Nudge (hold Shift for more)',
    group: 'Edit',
  },
  { keys: ['tab', 'shift+tab'], label: 'Next or previous card', group: 'Select' },
  {
    keys: ['alt+arrowup', 'alt+arrowdown', 'alt+arrowleft', 'alt+arrowright'],
    label: 'Nearest card in that direction',
    group: 'Select',
  },
  { keys: ['mod+a'], label: 'Select everything', group: 'Select' },
  { keys: ['escape'], label: 'Deselect, close', group: 'Select' },
  { keys: ['mod+k'], label: 'Search and commands', group: 'View' },
  { keys: ['shift+1'], label: 'Fit the board in view', group: 'View' },
  { keys: ['?'], label: 'Show shortcuts', group: 'View' },
];

const NUDGE: Record<string, [number, number]> = {
  arrowup: [0, -1],
  arrowdown: [0, 1],
  arrowleft: [-1, 0],
  arrowright: [1, 0],
};

export function useShortcuts(actions: BoardActions): void {
  const { ui, store } = useSession();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const is = (spec: string) => matchesShortcut(event, spec);

      if (is('mod+k')) {
        event.preventDefault();
        if (ui.palette.get().open) ui.closePalette();
        else ui.openPalette();
        return;
      }
      if (isTypingTarget(target) || ui.modalOpen()) return;
      if (target?.closest?.('.popover, dialog, .panel')) {
        // Panels keep their own keys, except the global undo/redo.
        if (!is('mod+z') && !is('shift+mod+z')) return;
      }

      const run = (fn: () => void) => {
        event.preventDefault();
        fn();
      };

      if (is('?')) return run(() => ui.shortcuts.set(true));
      if (is('mod+z')) return run(actions.undo);
      if (is('shift+mod+z') || is('mod+y')) return run(actions.redo);
      if (is('mod+a')) return run(() => store.selectAll());
      if (is('mod+d')) return run(actions.duplicateSelection);
      if (is('shift+1')) return run(actions.fit);
      if (is('escape')) {
        return run(() => {
          if (ui.editing.get()) ui.editing.set(null);
          else store.clearSelection();
        });
      }
      if (is('n')) return run(() => actions.addNode('note'));
      if (is('t')) return run(() => actions.addNode('task'));
      if (is('f')) return run(actions.frameSelection);
      if (is('enter')) return run(actions.editTitle);
      if (is('backspace') || is('delete')) return run(actions.deleteSelection);
      for (const [key, [dx, dy]] of Object.entries(NUDGE)) {
        const step = is(`shift+${key}`) ? GRID * 5 : is(key) ? GRID : 0;
        if (step) return run(() => actions.nudge(dx * step, dy * step));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actions, ui, store]);
}
