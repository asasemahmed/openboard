/**
 * Side panel slots. The right slot always holds the inspector, with tabs when
 * other right panels are registered. The left slot shows the open left panel,
 * if any; with nothing registered there it renders nothing at all.
 */
import type { KeyboardEvent } from 'react';
import { useSession } from '../state/context.js';
import { useStoreValue, useValue } from '../state/emitter.js';
import { IconButton } from '../ui/Button.js';
import { Icon } from '../ui/Icon.js';
import { Inspector } from './Inspector.js';
import { type PanelDef, panelById, panelsFor } from './registry.js';

const INSPECTOR: PanelDef = {
  id: 'inspector',
  side: 'right',
  title: 'Inspector',
  icon: 'edit',
  order: 0,
  Component: Inspector,
};

function rightPanels(): PanelDef[] {
  return [INSPECTOR, ...panelsFor('right').filter((p) => p.id !== INSPECTOR.id)];
}

/** A panel's badge count, re-read whenever the board (or its proposals, questions, comments) changes. */
function usePanelBadge(panel: PanelDef): number {
  const session = useSession();
  return useStoreValue(session.store, () => panel.badge?.(session) ?? 0);
}

function Badge({ panel, className = 'panel-badge' }: { panel: PanelDef; className?: string }) {
  const count = usePanelBadge(panel);
  if (count <= 0) return null;
  return (
    <span className={className} aria-hidden="true">
      {count > 99 ? '99+' : count}
    </span>
  );
}

function PanelTab({
  panel,
  active,
  onSelect,
  pending,
}: {
  panel: PanelDef;
  active: boolean;
  onSelect: () => void;
  /** Something waits in this tab while another is shown (the selected card, for the inspector). */
  pending?: string | undefined;
}) {
  const count = usePanelBadge(panel);
  const label = count > 0 ? `${panel.title} (${count})` : panel.title;
  return (
    <button
      type="button"
      role="tab"
      id={`panel-tab-${panel.id}`}
      aria-selected={active}
      aria-controls="panel-right-body"
      aria-label={pending ? `${label}: ${pending}` : label}
      title={pending ? `Show ${pending}` : undefined}
      tabIndex={active ? 0 : -1}
      className={`${active ? 'is-active' : ''}${pending ? ' has-pending' : ''}`}
      onClick={onSelect}
    >
      <Icon name={panel.icon} />
      {panel.title}
      {pending && <span className="panel-tab-dot" aria-hidden="true" />}
      <Badge panel={panel} className="panel-tab-badge" />
    </button>
  );
}

/**
 * What the inspector would show, while another tab is open: the selected
 * card's title, or a count. Selecting never switches tabs on its own, so a
 * review in progress is not interrupted; the inspector tab says it has
 * something instead.
 */
function useInspectorPending(active: string): string | undefined {
  const { store } = useSession();
  return useStoreValue(store, () => {
    if (active === INSPECTOR.id) return undefined;
    const { nodeIds, edgeIds } = store.selection;
    const total = nodeIds.length + edgeIds.length;
    if (total === 0) return undefined;
    if (nodeIds.length === 1 && edgeIds.length === 0)
      return store.node(nodeIds[0] as string)?.title ?? 'the selected card';
    return total === 1 ? 'the selected connection' : `${total} selected items`;
  });
}

export function RightPanel() {
  const { ui } = useSession();
  const open = useValue(ui.inspectorOpen);
  const active = useValue(ui.rightPanel);
  const panels = rightPanels();
  const current = panels.find((p) => p.id === active) ?? INSPECTOR;
  const pending = useInspectorPending(current.id);
  if (!open) return null;

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = panels.indexOf(current);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = panels[(index + step + panels.length) % panels.length];
    if (!next) return;
    event.preventDefault();
    ui.rightPanel.set(next.id);
    requestAnimationFrame(() => document.getElementById(`panel-tab-${next.id}`)?.focus());
  };

  return (
    <aside className="panel panel-right" aria-label={current.title}>
      {panels.length > 1 && (
        <div className="panel-tabs" role="tablist" aria-label="Panels" onKeyDown={onTabKey}>
          {panels.map((p) => (
            <PanelTab
              key={p.id}
              panel={p}
              active={p.id === current.id}
              onSelect={() => ui.rightPanel.set(p.id)}
              pending={p.id === INSPECTOR.id ? pending : undefined}
            />
          ))}
        </div>
      )}
      <div
        className="panel-scroll"
        id="panel-right-body"
        role={panels.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={panels.length > 1 ? `panel-tab-${current.id}` : undefined}
      >
        <current.Component />
      </div>
    </aside>
  );
}

export function LeftPanel() {
  const { ui } = useSession();
  const id = useValue(ui.leftPanel);
  const panel = panelById(id);
  if (!panel || panel.side !== 'left') return null;
  return (
    <aside className="panel panel-left" aria-label={panel.title}>
      <div className="panel-head">
        <h2>{panel.title}</h2>
        <IconButton
          icon="close"
          label={`Close ${panel.title.toLowerCase()}`}
          size="sm"
          onClick={() => ui.leftPanel.set(null)}
        />
      </div>
      <div className="panel-scroll">
        <panel.Component />
      </div>
    </aside>
  );
}

function PanelToggle({ panel }: { panel: PanelDef }) {
  const session = useSession();
  const { ui } = session;
  const left = useValue(ui.leftPanel);
  const right = useValue(ui.rightPanel);
  const rightOpen = useValue(ui.inspectorOpen);
  const badge = usePanelBadge(panel);
  const pressed = panel.side === 'left' ? left === panel.id : rightOpen && right === panel.id;
  const toggle = () => {
    if (panel.side === 'left') ui.leftPanel.set(pressed ? null : panel.id);
    else if (pressed) ui.inspectorOpen.set(false);
    else ui.showRightPanel(panel.id);
  };
  return (
    <button
      type="button"
      className={`icon-btn icon-btn-md panel-toggle panel-toggle-${panel.side}`}
      aria-pressed={pressed}
      aria-label={badge ? `${panel.title} (${badge})` : panel.title}
      title={panel.title}
      onClick={toggle}
    >
      <Icon name={panel.icon} />
      <Badge panel={panel} />
    </button>
  );
}

/** Top-bar toggles for registered panels on both sides. Renders nothing when there are none. */
export function PanelToggles() {
  const panels = [...panelsFor('left'), ...panelsFor('right')];
  if (panels.length === 0) return null;
  return (
    <div className="toolbar-group" role="group" aria-label="Panels">
      {panels.map((p) => (
        <PanelToggle key={p.id} panel={p} />
      ))}
    </div>
  );
}
