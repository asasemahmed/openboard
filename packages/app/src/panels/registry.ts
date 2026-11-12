/**
 * Side panels. The inspector is the built-in right panel; others (a
 * proposals queue, an activity feed) register here and get a slot and a
 * toggle in the top bar automatically. Nothing is drawn for a side that has
 * no registered panels.
 */
import type { ComponentType } from 'react';
import type { BoardSession } from '../state/session.js';
import type { IconName } from '../ui/Icon.js';

export type PanelSide = 'left' | 'right';

export interface PanelDef {
  id: string;
  side: PanelSide;
  title: string;
  icon: IconName;
  order?: number;
  /** Optional count shown on the toggle (for example, proposals waiting). */
  badge?: (session: BoardSession) => number;
  Component: ComponentType;
}

const panels: PanelDef[] = [];

export function registerPanel(def: PanelDef): () => void {
  const existing = panels.findIndex((p) => p.id === def.id);
  if (existing >= 0) panels.splice(existing, 1);
  panels.push(def);
  return () => {
    const index = panels.indexOf(def);
    if (index >= 0) panels.splice(index, 1);
  };
}

export function panelsFor(side: PanelSide): PanelDef[] {
  return panels.filter((p) => p.side === side).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function panelById(id: string | null): PanelDef | undefined {
  return id ? panels.find((p) => p.id === id) : undefined;
}
