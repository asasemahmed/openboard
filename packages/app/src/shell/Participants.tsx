import { useRef, useState } from 'react';
import { confirmUndoAll } from '../panels/ActivityPanel.js';
import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { ACTIVITY_PANEL } from '../state/review.js';
import { Avatar } from '../ui/Avatar.js';
import { Icon } from '../ui/Icon.js';
import { MenuHeading, MenuItem, MenuList, MenuSeparator } from '../ui/Menu.js';
import { Popover } from '../ui/Popover.js';

const SHOWN = 4;
const AGENTS_SHOWN = 3;

/** Who else is on this board right now, and the agents that have worked on it. */
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

/** The agents that have worked on this board, with what a person can do about each. */
function AgentsMenu() {
  const session = useSession();
  const { store, ui } = session;
  const actors = useStoreValue(store, () => store.meta.actors);
  const agents = Object.values(actors)
    .filter((a) => a.kind === 'agent')
    .sort((a, b) => a.name.localeCompare(b.name));
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (agents.length === 0) return null;
  const close = () => setOpen(false);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="agents-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Agents on this board: ${agents.map((a) => a.name).join(', ')}`}
        title="Agents on this board"
        onClick={() => setOpen(!open)}
      >
        <span className="agents-avatars" aria-hidden="true">
          {agents.slice(0, AGENTS_SHOWN).map((agent) => (
            <Avatar key={agent.id} actor={agent} size={22} />
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
          {agents.map((agent) => (
            <MenuItem
              key={agent.id}
              lead={<Avatar actor={agent} size={16} />}
              hint="Revert what it changed that is still in place"
              onSelect={() => {
                close();
                void confirmUndoAll(session, agent.id);
              }}
            >
              Undo everything by {agent.name}…
            </MenuItem>
          ))}
          <MenuSeparator />
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
