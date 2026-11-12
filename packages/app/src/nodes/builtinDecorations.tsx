/** Decorations every board shows. Registered once at startup. */
import type { CSSProperties } from 'react';
import { quietCounts } from '../lib/connections.js';
import type { FlowEdge } from '../lib/flow.js';
import { actorName } from '../state/activity.js';
import { useSession } from '../state/context.js';
import { useStoreValue, useValue } from '../state/emitter.js';
import { toasts } from '../state/toasts.js';
import { Icon } from '../ui/Icon.js';
import { type DecorationProps, registerNodeDecoration } from './decorations.js';

function PinBadge({ node }: DecorationProps) {
  const session = useSession();
  const unpin = () => {
    if (session.ui.readOnly) return;
    const outcome = session.store.apply(
      [{ op: 'move_node', id: node.id, view: { pinned: false } }],
      session.actor(),
    );
    if (outcome.ok) toasts.show('Unpinned. Tidy up can move it now.');
  };
  return (
    <button
      type="button"
      className="pin-badge nodrag"
      aria-label="Pinned. Unpin so tidy up can move it"
      title="Pinned: tidy up leaves it where it is. Click to unpin."
      onClick={(event) => {
        event.stopPropagation();
        unpin();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Icon name="pin" size={12} />
    </button>
  );
}

function PeerSelection({ node }: DecorationProps) {
  const { presence } = useSession();
  const key = useStoreValue(presence, () => presence.peersOnNode(node.id));
  if (!key) return null;
  const peers = key.split('\n').map((entry) => {
    const [color, ...name] = entry.split('|');
    return { color: color ?? 'currentColor', name: name.join('|') };
  });
  const first = peers[0];
  if (!first) return null;
  const names = peers.map((p) => p.name).join(', ');
  return (
    <div className="peer-outline" style={{ ['--peer' as string]: first.color }} aria-hidden="true">
      <span className="peer-tag" title={`Selected by ${names}`}>
        {peers.length > 1 ? `${first.name} +${peers.length - 1}` : first.name}
      </span>
    </div>
  );
}

/** A quiet robot glyph on nodes an agent created. People's nodes carry nothing. */
function AgentAuthor({ node }: DecorationProps) {
  const { store } = useSession();
  const actor = useStoreValue(store, () =>
    Object.hasOwn(store.meta.actors, node.createdBy)
      ? store.meta.actors[node.createdBy]
      : undefined,
  );
  if (actor?.kind !== 'agent') return null;
  const label = `Created by ${actor.name}`;
  return (
    <span className="author-mark" role="img" aria-label={label} title={label}>
      <Icon name="agent" size={13} />
    </span>
  );
}

/** Outline and "<name> · added" chip on what someone else just changed; fades out on its own. */
function RecentChange({ node }: DecorationProps) {
  const { activity, store } = useSession();
  const highlight = useStoreValue(activity, () => activity.highlightFor('node', node.id));
  const name = useStoreValue(store, () =>
    highlight ? actorName(store.meta.actors, highlight.actorId) : null,
  );
  if (!highlight) return null;
  const style = { '--recent-ms': `${highlight.until - highlight.at}ms` } as CSSProperties;
  return (
    <div key={highlight.at} className="recent-outline" style={style} aria-hidden="true">
      <span className="recent-chip">
        {name ?? 'Someone'} · {highlight.verb}
      </span>
    </div>
  );
}

/** Counts per edge list, so every card reads the same tally until an edge changes. */
const quietCountCache = new WeakMap<readonly FlowEdge[], Map<string, number>>();

/**
 * In the quiet view: how many connections of this node are out of sight, so
 * a card that looks alone still says it is not.
 */
function QuietConnections({ node }: DecorationProps) {
  const { store, ui } = useSession();
  const quiet = useValue(ui.connections) === 'quiet';
  const count = useStoreValue(store, () => {
    const edges = store.getEdges();
    let counts = quietCountCache.get(edges);
    if (!counts) {
      counts = quietCounts(store.boardEdges().values(), store.meta.actors);
      quietCountCache.set(edges, counts);
    }
    return counts.get(node.id) ?? 0;
  });
  if (!quiet || count === 0) return null;
  const label =
    count === 1
      ? '1 connection made by an agent. Point here to see it'
      : `${count} connections made by an agent. Point here to see them`;
  return (
    <span className="quiet-count" role="img" aria-label={label} title={label}>
      <Icon name="connection" size={12} />
      {count}
    </span>
  );
}

let registered = false;

export function registerBuiltinDecorations(): void {
  if (registered) return;
  registered = true;
  registerNodeDecoration({
    id: 'pin',
    slot: 'header',
    order: 100,
    applies: (node, ghost) => !ghost && node.view?.pinned === true,
    Component: PinBadge,
  });
  registerNodeDecoration({
    id: 'quiet-connections',
    slot: 'header',
    order: 20,
    applies: (_node, ghost) => !ghost,
    Component: QuietConnections,
  });
  registerNodeDecoration({
    id: 'agent-author',
    slot: 'header',
    order: 50,
    applies: (_node, ghost) => !ghost,
    Component: AgentAuthor,
  });
  registerNodeDecoration({
    id: 'recent-change',
    slot: 'overlay',
    order: 10,
    applies: (_node, ghost) => !ghost,
    Component: RecentChange,
  });
  registerNodeDecoration({
    id: 'peer-selection',
    slot: 'overlay',
    applies: (_node, ghost) => !ghost,
    Component: PeerSelection,
  });
}
