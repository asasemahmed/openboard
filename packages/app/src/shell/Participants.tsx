import { useSession } from '../state/context.js';
import { useStoreValue } from '../state/emitter.js';
import { Avatar } from '../ui/Avatar.js';

const SHOWN = 4;

/** Who else is on this board right now. */
export function Participants() {
  const { presence } = useSession();
  const people = useStoreValue(presence, presence.getParticipants);
  if (people.length === 0) return null;
  const names = people.map((p) =>
    p.actor.kind === 'agent' ? `${p.actor.name} (agent)` : p.actor.name,
  );
  return (
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
  );
}
