/**
 * Agents on the canvas: a labelled pointer chip per working agent session,
 * parked at the top-right corner of the first node it is focused on, gliding
 * there when its focus changes. Agents have no mouse; the chip says where
 * their attention is. Hover it for the status and what it is doing.
 */
import { useStore, ViewportPortal } from '@xyflow/react';
import { type AgentSession, cursorAnchor, plainLine } from '../lib/agents.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { STATUS_WORD, StatusGlyph } from '../ui/AgentStatus.js';

function tooltip(agent: AgentSession): string {
  const detail = plainLine(agent.detail, 160);
  return `${agent.actor.name}: ${STATUS_WORD[agent.status].toLowerCase()}${detail ? `, ${detail}` : ''}`;
}

export function AgentCursors() {
  const { presence, store } = useSession();
  const agents = useStoreValue(presence, presence.getAgents);
  const placements = useStoreValue(store, () => store.placements());
  const zoom = useStore((s) => s.transform[2]);
  const scale = 1 / zoom;
  const shown = agents.filter((a) => a.status !== 'idle' && a.focus.length > 0);
  if (shown.length === 0) return null;
  // Several sessions on one node stack their chips instead of covering each other.
  const perAnchor = new Map<string, number>();
  return (
    <ViewportPortal>
      <div className="agent-cursors">
        {shown.map((agent) => {
          const at = cursorAnchor(agent.focus, placements);
          if (!at) return null;
          const key = `${at.x},${at.y}`;
          const n = perAnchor.get(key) ?? 0;
          perAnchor.set(key, n + 1);
          return (
            <div
              key={agent.key}
              className="agent-cursor"
              style={{
                transform: `translate(${at.x - 6}px, ${at.y - 10 + n * 26 * scale}px) scale(${scale})`,
                ['--peer' as string]: agent.color,
              }}
              title={tooltip(agent)}
            >
              <svg
                width="16"
                height="20"
                viewBox="0 0 18 24"
                className="cursor-arrow"
                aria-hidden="true"
              >
                <path
                  d="M1.5 1.5v19l5.2-4.6 3.6 8 3.4-1.5-3.6-8 7-.5z"
                  fill={agent.color}
                  stroke="var(--canvas)"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="agent-cursor-tag" style={{ background: agent.color }}>
                <StatusGlyph status={agent.status} />
                {agent.actor.name}
              </span>
            </div>
          );
        })}
      </div>
    </ViewportPortal>
  );
}
