/** Decorations every board shows. Registered once at startup. */
import type { CSSProperties } from 'react';
import { actorName } from '../state/activity.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { toasts } from '../state/toasts.js';
import { Icon } from '../ui/Icon.js';
import { type DecorationProps, registerNodeDecoration } from './decorations.js';

function PinBadge({ node }: DecorationProps) {
  const session = useSession();
  const unpin = () => {
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
