/**
 * Side panel slots. The right slot always holds the inspector, with tabs when
 * other right panels are registered. The left slot shows the open left panel,
 * if any; with nothing registered there it renders nothing at all.
 */
import { useState } from 'react';
import { useSession } from '../state/context.js';
import { useValue } from '../state/emitter.js';
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

export function RightPanel() {
  const { ui } = useSession();
  const open = useValue(ui.inspectorOpen);
  const panels = [INSPECTOR, ...panelsFor('right').filter((p) => p.id !== INSPECTOR.id)];
  const [active, setActive] = useState(INSPECTOR.id);
  const current = panels.find((p) => p.id === active) ?? INSPECTOR;
  if (!open) return null;
  return (
    <aside className="panel panel-right" aria-label={current.title}>
      {panels.length > 1 && (
        <div className="panel-tabs" role="tablist" aria-label="Panels">
          {panels.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={p.id === current.id}
              className={p.id === current.id ? 'is-active' : ''}
              onClick={() => setActive(p.id)}
            >
              <Icon name={p.icon} />
              {p.title}
            </button>
          ))}
        </div>
      )}
      <div className="panel-scroll">
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

/** Top-bar toggles for registered left panels. Renders nothing when there are none. */
export function PanelToggles() {
  const session = useSession();
  const open = useValue(session.ui.leftPanel);
  const panels = panelsFor('left');
  if (panels.length === 0) return null;
  return (
    <div className="toolbar-group" role="group" aria-label="Panels">
      {panels.map((p) => {
        const badge = p.badge?.(session) ?? 0;
        return (
          <button
            key={p.id}
            type="button"
            className="icon-btn icon-btn-md panel-toggle"
            aria-pressed={open === p.id}
            aria-label={badge ? `${p.title} (${badge})` : p.title}
            title={p.title}
            onClick={() => session.ui.leftPanel.set(open === p.id ? null : p.id)}
          >
            <Icon name={p.icon} />
            {badge > 0 && <span className="panel-badge">{badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
