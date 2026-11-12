import { Panel, useStore } from '@xyflow/react';
import { useSession } from '../state/context.js';
import { useValue } from '../state/emitter.js';
import { IconButton } from '../ui/Button.js';
import type { BoardActions } from './actions.js';

export function ZoomControls({ actions }: { actions: BoardActions }) {
  const { ui } = useSession();
  const zoom = useStore((s) => s.transform[2]);
  const minimap = useValue(ui.minimap);
  const allConnections = useValue(ui.connections) === 'all';
  return (
    <Panel position="bottom-left" className="zoom-controls" aria-label="Zoom">
      <IconButton icon="minus" label="Zoom out" size="sm" onClick={actions.zoomOut} />
      <button
        type="button"
        className="zoom-level"
        onClick={actions.resetZoom}
        title="Reset to 100%"
        aria-label={`Zoom ${Math.round(zoom * 100)}%. Reset to 100%`}
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconButton icon="plus" label="Zoom in" size="sm" onClick={actions.zoomIn} />
      <span className="zoom-sep" aria-hidden="true" />
      <IconButton
        icon="fit"
        label="Fit board in view"
        shortcut="shift+1"
        size="sm"
        onClick={actions.fit}
      />
      <IconButton
        icon="connection"
        label={
          allConnections
            ? 'Show agent-made connections only for the card you point at'
            : 'Show every connection'
        }
        size="sm"
        pressed={allConnections}
        onClick={() => ui.connections.set(allConnections ? 'quiet' : 'all')}
      />
      <IconButton
        icon="minimap"
        label={minimap ? 'Hide mini map' : 'Show mini map'}
        size="sm"
        pressed={minimap}
        onClick={() => ui.minimap.set(!minimap)}
      />
    </Panel>
  );
}
