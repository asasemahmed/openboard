/**
 * The top bar's "More" menu. Below `TOPBAR_FOLD` it holds the secondary
 * actions the bar no longer has room for; below `TOPBAR_NARROW` also tidy up.
 * Above the fold it is not shown at all.
 */
import { useRef, useState } from 'react';
import { useActions } from '../canvas/actions.js';
import { TOPBAR_NARROW, useMediaQuery } from '../lib/media.js';
import { setThemePref, THEME_ORDER, useTheme } from '../lib/theme.js';
import { useSession } from '../state/context.js';
import { IconButton } from '../ui/Button.js';
import { MenuHeading, MenuItem, MenuList, MenuSeparator } from '../ui/Menu.js';
import { Popover } from '../ui/Popover.js';
import { THEME_NAMES } from './ThemeToggle.js';

export function OverflowMenu() {
  const { ui } = useSession();
  const actions = useActions();
  const { pref } = useTheme();
  const narrow = useMediaQuery(TOPBAR_NARROW);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <span className="topbar-overflow">
      <IconButton
        ref={anchor}
        icon="more"
        label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        role="menu"
        label="More"
        align="end"
      >
        <MenuList label="More">
          <MenuItem icon="agent" onSelect={run(() => ui.connectAgent.set(true))}>
            Connect an agent
          </MenuItem>
          {narrow && (
            <>
              <MenuItem
                icon="layout"
                hint="Leaves pinned nodes where they are"
                onSelect={run(() => void actions.tidy('unpinned'))}
              >
                Tidy up
              </MenuItem>
              <MenuItem
                icon="warning"
                hint="Moves and unpins every node"
                onSelect={run(() =>
                  ui.confirm.set({
                    title: 'Tidy everything?',
                    body: 'This also moves nodes that you or others placed by hand, and unpins them. Undo does not reverse a layout.',
                    actions: [
                      { label: 'Cancel', run: () => {} },
                      {
                        label: 'Tidy everything',
                        tone: 'primary',
                        run: () => void actions.tidy('all'),
                      },
                    ],
                  }),
                )}
              >
                Tidy everything…
              </MenuItem>
            </>
          )}
          <MenuItem icon="keyboard" shortcut="?" onSelect={run(() => ui.shortcuts.set(true))}>
            Keyboard shortcuts
          </MenuItem>
          <MenuItem icon="settings" onSelect={run(() => ui.settings.set(true))}>
            Settings
          </MenuItem>
          <MenuSeparator />
          <MenuHeading>Theme</MenuHeading>
          {THEME_ORDER.map((theme) => (
            <MenuItem
              key={theme}
              checked={pref === theme}
              onSelect={run(() => setThemePref(theme))}
            >
              {THEME_NAMES[theme]}
            </MenuItem>
          ))}
        </MenuList>
      </Popover>
    </span>
  );
}
