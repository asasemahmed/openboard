import { useActions } from '../canvas/actions.js';
import { navigate } from '../lib/router.js';
import { PanelToggles } from '../panels/PanelSlot.js';
import { useSession, useUndoState } from '../state/context.js';
import { useValue } from '../state/emitter.js';
import { IconButton, Kbd } from '../ui/Button.js';
import { Icon, Logo } from '../ui/Icon.js';
import { AddMenu } from './AddMenu.js';
import { ConnectAgentButton, FollowToggle } from './AgentControls.js';
import { BoardName } from './BoardName.js';
import { BoardSwitcher } from './BoardSwitcher.js';
import { ConnectionStatus } from './ConnectionStatus.js';
import { Participants } from './Participants.js';
import { ProfileMenu } from './ProfileMenu.js';
import { ThemeToggle } from './ThemeToggle.js';
import { TidyMenu } from './TidyMenu.js';

export function TopBar() {
  const { ui } = useSession();
  const actions = useActions();
  const undo = useUndoState();
  const inspectorOpen = useValue(ui.inspectorOpen);

  return (
    <header className="topbar">
      <div className="topbar-start">
        <a
          href="/"
          className="home-link"
          aria-label="All boards"
          title="All boards"
          onClick={(event) => {
            event.preventDefault();
            navigate('/');
          }}
        >
          <Logo size={24} />
        </a>
        <div className="board-title">
          <BoardName />
          <BoardSwitcher />
        </div>
        <span className="topbar-sep" aria-hidden="true" />
        <div className="toolbar-group" role="group" aria-label="History">
          <IconButton
            icon="undo"
            label="Undo"
            shortcut="mod+z"
            disabled={!undo.canUndo}
            onClick={actions.undo}
          />
          <IconButton
            icon="redo"
            label="Redo"
            shortcut="shift+mod+z"
            disabled={!undo.canRedo}
            onClick={actions.redo}
          />
        </div>
        <AddMenu />
        <TidyMenu />
        <button
          type="button"
          className="search-btn"
          onClick={() => ui.openPalette()}
          aria-label="Search and commands"
        >
          <Icon name="search" />
          <span className="search-btn-text">Search</span>
          <Kbd shortcut="mod+k" />
        </button>
      </div>
      <div className="topbar-end">
        <div className="toolbar-group" role="group" aria-label="Agents">
          <ConnectAgentButton />
          <FollowToggle />
        </div>
        <PanelToggles />
        <ConnectionStatus />
        <Participants />
        <span className="topbar-sep" aria-hidden="true" />
        <IconButton
          icon="keyboard"
          label="Keyboard shortcuts"
          shortcut="?"
          onClick={() => ui.shortcuts.set(true)}
        />
        <ThemeToggle />
        <IconButton
          icon="edit"
          label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
          pressed={inspectorOpen}
          onClick={() => ui.inspectorOpen.set(!inspectorOpen)}
        />
        <ProfileMenu />
      </div>
    </header>
  );
}
