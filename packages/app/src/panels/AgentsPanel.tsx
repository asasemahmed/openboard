/**
 * What agents are doing right now: the live session tree the server
 * publishes, with subagents under their parent. Everything an agent's tools
 * report is untrusted text, so it is shown as plain, cut text only.
 */
import type { AgentStatus, Session } from '@openboard/core';
import { useReactFlow } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { reducedMotion } from '../canvas/actions.js';
import {
  type AgentSession,
  elapsed,
  flattenTree,
  plainLine,
  type SessionNode,
  sessionTree,
} from '../lib/agents.js';
import { absoluteTime, relativeTime } from '../lib/time.js';
import { useSession } from '../state/context.js';
import { useStoreValue, useValue } from '../state/emitter.js';
import { openReview } from '../state/review.js';
import type { BoardSession } from '../state/session.js';
import { StatusLabel } from '../ui/AgentStatus.js';
import { Avatar } from '../ui/Avatar.js';
import { Icon } from '../ui/Icon.js';

/** The current time, ticking each second only while something is running. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/** The board presence entry of a live session, if its agent is on this board. */
function presenceOf(agents: readonly AgentSession[], s: Session): AgentSession | undefined {
  return agents.find((a) => a.actor.id === s.actor && a.session === s.id);
}

/** What an agent waits for on this board, when the app can tell. */
export function WaitingLinks({ actorId }: { actorId: string }) {
  const session = useSession();
  const { store, ui } = session;
  const proposal = useStoreValue(store, () =>
    store.review().pending.find((p) => p.author === actorId),
  );
  const ask = useStoreValue(store, () => store.openAsks().find((a) => a.author === actorId));
  if (!proposal && !ask) return null;
  return (
    <span className="waiting-links">
      {proposal && (
        <button type="button" className="link-btn" onClick={() => openReview(session, proposal.id)}>
          Waiting for your review
        </button>
      )}
      {ask && (
        <button type="button" className="link-btn" onClick={() => ui.asksCollapsed.set(false)}>
          Waiting for your answer
        </button>
      )}
    </span>
  );
}

function statusOf(s: Session, presence: AgentSession | undefined): AgentStatus {
  if (presence && presence.status !== 'idle') return presence.status;
  if (s.current) return 'working';
  return s.status === 'active' ? 'working' : 'idle';
}

export function AgentsPanel() {
  const session = useSession();
  const { presence } = session;
  const live = useStoreValue(presence, presence.getLive);
  const agents = useStoreValue(presence, presence.getAgents);
  const rows = useMemo(() => flattenTree(sessionTree(live?.sessions ?? [])), [live]);
  const running = rows.some((r) => r.session.current);
  const now = useNow(running);

  // Agents on this board that report no session list still count as present.
  const unlisted = agents.filter(
    (a) => !rows.some((r) => r.session.actor === a.actor.id && r.session.id === a.session),
  );

  if (rows.length === 0 && unlisted.length === 0) {
    return (
      <div className="panel-empty">
        <Icon name="agent" size={20} />
        <p>No agents are working right now.</p>
        <p className="small">
          To see each step an agent takes, turn on its activity recorder: run{' '}
          <code>openboard connect</code> and follow the setup for your agent, or see the
          integrations docs.
        </p>
      </div>
    );
  }

  return (
    <ol className="session-list" aria-label="Agent sessions">
      {rows.map((node) => (
        <SessionRow
          key={node.session.id}
          node={node}
          presence={presenceOf(agents, node.session)}
          now={now}
        />
      ))}
      {unlisted.map((a) => (
        <PresenceRow key={a.key} agent={a} />
      ))}
    </ol>
  );
}

function usePanTo(session: BoardSession) {
  const flow = useReactFlow();
  return (ids: readonly string[]) => {
    const known = ids.filter((id) => session.store.node(id));
    if (known.length === 0) return;
    session.ui.pauseFollow();
    void flow.fitView({
      nodes: known.map((id) => ({ id })),
      duration: reducedMotion() ? 0 : 280,
      padding: 0.35,
      maxZoom: 1.1,
    });
  };
}

function useClaimsBy(actorId: string, sessionId: string): string[] {
  const { claims } = useSession();
  const key = useStoreValue(claims, () =>
    [...claims.get().values()]
      .filter((c) => c.by === actorId && (c.session === undefined || c.session === sessionId))
      .map((c) => c.nodeId)
      .join('\n'),
  );
  return key ? key.split('\n') : [];
}

function SessionRow({
  node,
  presence,
  now,
}: {
  node: SessionNode;
  presence: AgentSession | undefined;
  now: number;
}) {
  const session = useSession();
  const { store, ui } = session;
  const s = node.session;
  const actor = useStoreValue(store, () => store.meta.actors[s.actor]);
  const name = actor?.name ?? presence?.actor.name ?? s.actor;
  const status = statusOf(s, presence);
  const claimed = useClaimsBy(s.actor, s.id);
  const followed = useValue(ui.followSession) === `${s.actor}/${s.id}`;
  const pan = usePanTo(session);
  const focus = presence?.focus ?? [];
  const label = plainLine(s.label, 80);

  return (
    <li
      className={`session-row depth-${Math.min(node.depth, 4)}${node.depth > 0 ? ' is-child' : ''}`}
      style={{ ['--depth' as string]: node.depth }}
    >
      <div className="session-head">
        <Avatar
          actor={actor ?? presence?.actor ?? { id: s.actor, name, kind: 'agent' }}
          size={20}
        />
        <button
          type="button"
          className="session-name"
          disabled={focus.length === 0}
          title={focus.length ? 'Show what it is working on' : undefined}
          onClick={() => pan(focus)}
        >
          <strong>{name}</strong>
          {label && <span className="session-label">{label}</span>}
        </button>
        <StatusLabel status={status} />
      </div>
      <div className="session-now">
        {s.current ? (
          <>
            <span className="session-tool">{plainLine(s.current.tool, 40)}</span>
            <span className="session-summary">{plainLine(s.current.summary)}</span>
            <span className="session-timer" title={`Since ${absoluteTime(s.current.since)}`}>
              {elapsed(s.current.since, now)}
            </span>
          </>
        ) : presence?.detail ? (
          <span className="session-summary">{plainLine(presence.detail)}</span>
        ) : (
          <span className="session-summary muted">
            {status === 'idle' ? `Last active ${relativeTime(s.lastAt)}` : 'Between steps'}
          </span>
        )}
      </div>
      <div className="session-meta">
        <span>
          {s.counts.tools} tool{s.counts.tools === 1 ? '' : 's'}
        </span>
        <span className={s.counts.errors ? 'session-errors' : ''}>
          {s.counts.errors} error{s.counts.errors === 1 ? '' : 's'}
        </span>
        {node.orphan && <span title="Its parent session has ended">subagent</span>}
        {focus.length > 0 && (
          <button
            type="button"
            className="link-btn"
            aria-pressed={followed}
            onClick={() => {
              if (followed) ui.followSession.set(null);
              else {
                ui.followSession.set(`${s.actor}/${s.id}`);
                ui.follow.set('on');
                pan(focus);
              }
            }}
          >
            {followed ? 'Following' : 'Follow'}
          </button>
        )}
        {status === 'waiting' && <WaitingLinks actorId={s.actor} />}
      </div>
      {claimed.length > 0 && <Claimed ids={claimed} onPan={pan} />}
      {s.recent.length > 0 && (
        <details className="session-steps">
          <summary>Recent steps ({s.recent.length})</summary>
          <ol>
            {[...s.recent].reverse().map((step, i) => (
              <li key={`${step.at}-${i}`} className={step.ok === false ? 'is-failed' : ''}>
                <span className="session-tool">{plainLine(step.tool, 40)}</span>
                <span className="session-summary">{plainLine(step.summary, 90)}</span>
                {step.ok === false && <span className="visually-hidden">failed</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  );
}

function Claimed({ ids, onPan }: { ids: readonly string[]; onPan: (ids: string[]) => void }) {
  const { store } = useSession();
  const titles = useStoreValue(store, () =>
    ids.map((id) => store.node(id)?.title ?? id).join('\n'),
  );
  return (
    <div className="session-claims">
      <span className="muted">Claimed:</span>
      {titles.split('\n').map((title, i) => (
        <button
          key={ids[i]}
          type="button"
          className="claim-pill"
          onClick={() => onPan([ids[i] as string])}
        >
          {plainLine(title, 40)}
        </button>
      ))}
    </div>
  );
}

/** An agent on this board that the session list does not (yet) include. */
function PresenceRow({ agent }: { agent: AgentSession }) {
  const session = useSession();
  const pan = usePanTo(session);
  return (
    <li className="session-row">
      <div className="session-head">
        <Avatar actor={agent.actor} size={20} />
        <button
          type="button"
          className="session-name"
          disabled={agent.focus.length === 0}
          onClick={() => pan(agent.focus)}
        >
          <strong>{agent.actor.name}</strong>
          {agent.session !== 'default' && (
            <span className="session-label">{plainLine(agent.session, 40)}</span>
          )}
        </button>
        <StatusLabel status={agent.status} />
      </div>
      <div className="session-now">
        <span className="session-summary">
          {agent.detail ? plainLine(agent.detail) : `Since ${relativeTime(agent.at)}`}
        </span>
      </div>
      {agent.status === 'waiting' && (
        <div className="session-meta">
          <WaitingLinks actorId={agent.actor.id} />
        </div>
      )}
    </li>
  );
}
