import { useRef, useState } from 'react';
import { boardPath, navigate } from '../lib/router.js';
import { boards, useBoards } from '../state/boards.js';
import { useSession } from '../state/context.js';
import { Icon } from '../ui/Icon.js';
import { MenuHeading, MenuItem, MenuList, MenuSeparator } from '../ui/Menu.js';
import { Popover } from '../ui/Popover.js';

const SHOWN = 12;

export function BoardSwitcher() {
  const session = useSession();
  const list = useBoards();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="icon-btn icon-btn-sm"
        aria-label="Switch board"
        title="Switch board"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) void boards.refresh();
          setOpen(!open);
        }}
      >
        <Icon name="chevronDown" />
      </button>
      <Popover anchor={anchor} open={open} onClose={close} role="menu" label="Boards">
        <MenuList label="Boards">
          <MenuHeading>Boards</MenuHeading>
          {list.boards.slice(0, SHOWN).map((board) => (
            <MenuItem
              key={board.id}
              checked={board.id === session.boardId}
              hint={`${board.nodeCount} nodes`}
              onSelect={() => {
                close();
                navigate(boardPath(board.id));
              }}
            >
              {board.name}
            </MenuItem>
          ))}
          {list.status === 'loading' && list.boards.length === 0 && (
            <p className="menu-note">Loading boards…</p>
          )}
          {list.status === 'error' && <p className="menu-note">Could not load boards.</p>}
          <MenuSeparator />
          <MenuItem
            icon="plus"
            onSelect={() => {
              close();
              session.ui.newBoard.set(true);
            }}
          >
            New board…
          </MenuItem>
          <MenuItem
            icon="boards"
            onSelect={() => {
              close();
              navigate('/');
            }}
          >
            All boards
          </MenuItem>
        </MenuList>
      </Popover>
    </>
  );
}
