import type { Actor, AgentStatus } from '@openboard/core';
import { useRef, useState } from 'react';
import { type AgentGroup, groupByAgent, workingCount } from '../lib/agents.js';
import { confirmUndoAll } from '../panels/ActivityPanel.js';
import { useCan } from '../state/access.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { ACTIVITY_PANEL, AGENTS_PANEL } from '../state/review.js';
import { STATUS_WORD, StatusGlyph } from '../ui/AgentStatus.js';
import { Avatar } from '../ui/Avatar.js';
import { Icon } from '../ui/Icon.js';
import { MenuHeading, MenuItem, MenuList, MenuSeparator } from '../ui/Menu.js';
import { Popover } from '../ui/Popover.js';

const SHOWN = 4;
const AGENTS_SHOWN = 3;

/** Who else is on this board right now: people, then the agents working on it. */
export function Participants() {
  const { presence } = useSession();
  const people = useStoreValue(presence, presence.getParticipants);
  const names = people.map((p) =>
    p.actor.kind === 'agent' ? `${p.actor.name} (agent)` : p.actor.name,
  );
  return (
    <>
      {people.length > 0 && (
        <ul className="participants" aria-label={`Also here: ${names.join(', ')}`}>
          {people.slice(0, SHOWN).map((peer, i) => (
            <li key={peer.actor.id} title={names[i]}>
              <Avatar actor={{ ...peer.actor, color: peer.color }} size={26} />
            </li>
          ))}
          {people.length > SHOWN && (
            <li className="participants-more" title={names.slice(SHOWN).join(', ')}>
              +{people.length - SHOWN}
            </li>
          )}
        </ul>
      )}
      <AgentsMenu />
    </>
  );
}

/** "N agents working": opens the agents panel. Hidden while none is. */
export function AgentsWorking() {
  const { presence, ui } = useSession();
  const count = useStoreValue(presence, () =>
    workingCount(presence.getAgents(), presence.getLive()),
  );
  if (count === 0) return null;
  const label = `${count} agent${count === 1 ? '' : 's'} working`;
  return (
    <button
      type="button"
      className="topbar-text-btn agents-working"
      title="Show what agents are doing"
      aria-label={label}
      onClick={() => ui.leftPanel.set(AGENTS_PANEL)}
    >
      <span className="agents-working-mark" aria-hidden="true" />
      <span aria-hidden="true">{count}</span>
      <span className="topbar-label" aria-hidden="true">
        {count === 1 ? 'agent working' : 'agents working'}
      </span>
    </button>
  );
}

interface MenuAgent {
  actor: Actor;
  group: AgentGroup | undefined;
}

/** Agents present on the board, with their busiest status; then agents that worked on it before. */
function useMenuAgents(): MenuAgent[] {
  const { store, presence } = useSession();
  const actors = useStoreValue(store, () => store.meta.actors);
  const sessions = useStoreValue(presence, presence.getAgents);
  const groups = groupByAgent(sessions);
  const present = groups.map((group) => ({
    actor: actors[group.actor.id] ?? group.actor,
    group,
  }));
  const absent = Object.values(actors)
    .filter((a) => a.kind === 'agent' && !groups.some((g) => g.actor.id === a.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((actor) => ({ actor, group: undefined }));
  return [...present, ...absent];
}

function describe(agent: MenuAgent): string {
  if (!agent.group) return `${agent.actor.name} (not active)`;
  const n = agent.group.sessions.length;
  return `${agent.actor.name}: ${STATUS_WORD[agent.group.status].toLowerCase()}${n > 1 ? `, ${n} sessions` : ''}`;
}

/** The agents of this board, with what a person can do about each. */
function AgentsMenu() {
  const session = useSession();
  const { ui } = session;
  const agents = useMenuAgents();
  const canUndo = useCan('board.undo');
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (agents.length === 0) return null;
  const close = () => setOpen(false);
  const shown = agents.slice(0, AGENTS_SHOWN);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="agents-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Agents: ${agents.map(describe).join('; ')}`}
        title="Agents on this board"
        onClick={() => setOpen(!open)}
      >
        <span className="agents-avatars">
          {shown.map((agent) => (
            <AgentAvatar
              key={agent.actor.id}
              actor={agent.actor}
              status={agent.group?.status}
              count={agent.group?.sessions.length ?? 0}
            />
          ))}
        </span>
        {agents.length > AGENTS_SHOWN && (
          <span className="agents-more">+{agents.length - AGENTS_SHOWN}</span>
        )}
        <Icon name="chevronDown" size={14} />
      </button>
      <Popover anchor={anchor} open={open} onClose={close} align="end" role="menu" label="Agents">
        <MenuList label="Agents">
          <MenuHeading>Agents on this board</MenuHeading>
          {canUndo &&
            agents.map((agent) => (
              <MenuItem
                key={agent.actor.id}
                lead={<Avatar actor={agent.actor} size={16} />}
                hint={
                  agent.group
                    ? `${STATUS_WORD[agent.group.status]}${agent.group.sessions.length > 1 ? `, ${agent.group.sessions.length} sessions` : ''}. Revert what it changed that is still in place`
                    : 'Revert what it changed that is still in place'
                }
                onSelect={() => {
                  close();
                  void confirmUndoAll(session, agent.actor.id);
                }}
              >
                Undo everything by {agent.actor.name}…
              </MenuItem>
            ))}
          <MenuSeparator />
          <MenuItem
            icon="agent"
            onSelect={() => {
              close();
              ui.leftPanel.set(AGENTS_PANEL);
            }}
          >
            Show what agents are doing
          </MenuItem>
          <MenuItem
            icon="history"
            onSelect={() => {
              close();
              ui.leftPanel.set(ACTIVITY_PANEL);
            }}
          >
            Show activity
          </MenuItem>
          <MenuItem
            icon="settings"
            onSelect={() => {
              close();
              ui.settings.set(true);
            }}
          >
            Review policy…
          </MenuItem>
        </MenuList>
      </Popover>
    </>
  );
}

/** An agent's avatar with its status in the corner and, for several sessions, a count. */
function AgentAvatar({
  actor,
  status,
  count,
}: {
  actor: Actor;
  status: AgentStatus | undefined;
  count: number;
}) {
  return (
    <span className={`agent-avatar${status ? '' : ' is-absent'}`}>
      <Avatar actor={actor} size={22} />
      {status && <StatusGlyph status={status} size={9} />}
      {count > 1 && (
        <span className="agent-avatar-count" aria-hidden="true">
          {count}
        </span>
      )}
    </span>
  );
}
