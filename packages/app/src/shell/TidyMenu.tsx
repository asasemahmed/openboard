import { useRef, useState } from 'react';
import { useActions } from '../canvas/actions.js';
import { useSession } from '../state/context.js';
import { Icon } from '../ui/Icon.js';
import { MenuItem, MenuList } from '../ui/Menu.js';
import { Popover } from '../ui/Popover.js';

/** "Tidy up" lays out what nobody pinned; the menu offers laying out everything. */
export function TidyMenu() {
  const actions = useActions();
  const { ui } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  const run = async (scope: 'unpinned' | 'all') => {
    setBusy(true);
    try {
      await actions.tidy(scope);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="split-btn">
      <button
        type="button"
        className="btn btn-default btn-md split-main"
        onClick={() => void run('unpinned')}
        disabled={busy}
        title="Lay out everything nobody pinned by hand"
      >
        <Icon name="layout" />
        <span>{busy ? 'Tidying…' : 'Tidy up'}</span>
      </button>
      <button
        ref={anchor}
        type="button"
        className="btn btn-default btn-md split-more"
        aria-label="More layout options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        disabled={busy}
      >
        <Icon name="chevronDown" />
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        role="menu"
        label="Layout"
        align="end"
      >
        <MenuList label="Layout">
          <MenuItem
            icon="layout"
            hint="Leaves pinned nodes where they are"
            onSelect={() => {
              setOpen(false);
              void run('unpinned');
            }}
          >
            Tidy up
          </MenuItem>
          <MenuItem
            icon="warning"
            hint="Moves and unpins every node"
            onSelect={() => {
              setOpen(false);
              ui.confirm.set({
                title: 'Tidy everything?',
                body: 'This also moves nodes that you or others placed by hand, and unpins them. Undo does not reverse a layout.',
                actions: [
                  { label: 'Cancel', run: () => {} },
                  { label: 'Tidy everything', tone: 'primary', run: () => void run('all') },
                ],
              });
            }}
          >
            Tidy everything…
          </MenuItem>
        </MenuList>
      </Popover>
    </div>
  );
}
