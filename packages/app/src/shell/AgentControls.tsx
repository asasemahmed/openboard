/** Top-bar controls for working alongside agents: connect one, and follow what others change. */
import { useSession } from '../state/context.js';
import { useValue } from '../state/emitter.js';
import { Icon } from '../ui/Icon.js';

export function ConnectAgentButton() {
  const { ui } = useSession();
  return (
    <button
      type="button"
      className="topbar-text-btn"
      onClick={() => ui.connectAgent.set(true)}
      title="Connect an agent"
    >
      <Icon name="agent" />
      <span className="topbar-text-btn-label">Connect an agent</span>
    </button>
  );
}

export function FollowToggle() {
  const { ui } = useSession();
  const follow = useValue(ui.follow);
  const paused = follow === 'paused';
  const label = paused
    ? 'Follow changes (paused because you moved the view; click to resume)'
    : 'Follow changes';
  return (
    <button
      type="button"
      className={`topbar-text-btn follow-btn${paused ? ' is-paused' : ''}`}
      aria-pressed={follow !== 'off'}
      aria-label={label}
      title={
        follow === 'on'
          ? 'Following: the view moves to what others change. Click to stop.'
          : paused
            ? 'Paused because you moved the view. Click to follow again.'
            : 'Follow changes: move the view to what others change.'
      }
      onClick={() => ui.follow.set(follow === 'on' ? 'off' : 'on')}
    >
      <Icon name="follow" />
      <span className="topbar-text-btn-label">{paused ? 'Paused' : 'Follow'}</span>
    </button>
  );
}
