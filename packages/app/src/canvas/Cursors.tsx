/** Other participants' pointers, drawn in canvas space with a name tag (as in the banner). */
import { useStore, ViewportPortal } from '@xyflow/react';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';

export function Cursors() {
  const { presence } = useSession();
  const peers = useStoreValue(presence, presence.getPeers);
  const zoom = useStore((s) => s.transform[2]);
  const scale = 1 / zoom;
  return (
    <ViewportPortal>
      <div className="cursors" aria-hidden="true">
        {peers.map((peer) =>
          peer.cursor ? (
            <div
              key={peer.clientId}
              className={`cursor cursor-${peer.actor.kind}`}
              style={{
                transform: `translate(${peer.cursor.x}px, ${peer.cursor.y}px) scale(${scale})`,
                ['--peer' as string]: peer.color,
              }}
            >
              <svg width="18" height="24" viewBox="0 0 18 24" className="cursor-arrow">
                <path
                  d="M1.5 1.5v19l5.2-4.6 3.6 8 3.4-1.5-3.6-8 7-.5z"
                  fill={peer.color}
                  stroke="var(--canvas)"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="cursor-tag" style={{ background: peer.color }}>
                {peer.actor.name}
              </span>
            </div>
          ) : null,
        )}
      </div>
    </ViewportPortal>
  );
}
