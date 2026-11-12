import { useRef, useState } from 'react';
import { exportChoices } from '../lib/exportChoices.js';
import { boardPath, navigate } from '../lib/router.js';
import { useCan } from '../state/access.js';
import { boards, serverInfo, useBoards } from '../state/boards.js';
import { useSession } from '../state/context.js';
import { useValue } from '../state/emitter.js';
import { Icon } from '../ui/Icon.js';
import { MenuHeading, MenuItem, MenuList, MenuSeparator } from '../ui/Menu.js';
import { Popover } from '../ui/Popover.js';
import { copyBoardAs, exportBoard } from './boardActions.js';

const SHOWN = 12;

export function BoardSwitcher() {
  const session = useSession();
  const list = useBoards();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  const canEdit = useCan('board.edit');
  const canCreate = useCan('board.create');
  const info = useValue(serverInfo);
  const selectedFrame = (): string | null => {
    const ids = session.store.selection.nodeIds;
    const node = ids.length === 1 ? session.store.node(ids[0] as string) : undefined;
    return node?.type === 'frame' ? node.id : null;
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="icon-btn icon-btn-sm"
        aria-label="Board menu"
        title="Boards, import and export"
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
          <MenuHeading>This board</MenuHeading>
          {canEdit && (
            <MenuItem
              icon="plus"
              hint="Mermaid or JSON Canvas"
              onSelect={() => {
                close();
                session.ui.importDialog.set({});
              }}
            >
              Import…
            </MenuItem>
          )}
          {canEdit && (
            <MenuItem
              icon="layout"
              hint="A plan, a map, a kanban…"
              onSelect={() => {
                close();
                session.ui.templateDialog.set({ frame: selectedFrame() });
              }}
            >
              Insert template…
            </MenuItem>
          )}
          {exportChoices(info).map((choice) => (
            <MenuItem
              key={`${choice.format}:${choice.theme ?? ''}`}
              icon="file"
              {...(choice.plugin ? { hint: choice.plugin } : {})}
              onSelect={() => {
                close();
                void exportBoard(session, choice);
              }}
            >
              Export as {choice.label}
            </MenuItem>
          ))}
          <MenuItem
            icon="copy"
            onSelect={() => {
              close();
              void copyBoardAs(session, 'mermaid');
            }}
          >
            Copy as Mermaid
          </MenuItem>
          <MenuItem
            icon="copy"
            onSelect={() => {
              close();
              void copyBoardAs(session, 'markdown');
            }}
          >
            Copy as Markdown
          </MenuItem>
          <MenuItem
            icon="history"
            onSelect={() => {
              close();
              session.ui.comparePicker.set(true);
            }}
          >
            Compare with a git revision…
          </MenuItem>
          <MenuSeparator />
          {canCreate && (
            <MenuItem
              icon="plus"
              onSelect={() => {
                close();
                session.ui.newBoard.set(true);
              }}
            >
              New board…
            </MenuItem>
          )}
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
