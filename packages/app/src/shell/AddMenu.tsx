import { useRef, useState } from 'react';
import { useActions } from '../canvas/actions.js';
import { ADDABLE_TYPES, typeMeta } from '../lib/nodeTypes.js';
import { Button } from '../ui/Button.js';
import { MenuItem, MenuList } from '../ui/Menu.js';
import { Popover } from '../ui/Popover.js';

export function TypeDot({ type }: { type: string }) {
  return <span className={`type-dot tone-${typeMeta(type).tone}`} aria-hidden="true" />;
}

/** "Add" menu: one entry per type, added in the middle of the view. */
export function AddMenu() {
  const actions = useActions();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={anchor}
        icon="plus"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        aria-label="Add"
      >
        <span className="topbar-label">Add</span>
      </Button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} role="menu" label="Add">
        <MenuList label="Add a node">
          {ADDABLE_TYPES.map((type) => {
            const meta = typeMeta(type);
            return (
              <MenuItem
                key={type}
                lead={<TypeDot type={type} />}
                hint={meta.hint}
                shortcut={meta.key}
                onSelect={() => {
                  setOpen(false);
                  if (type === 'frame') actions.frameSelection();
                  else actions.addNode(type, actions.viewCenter());
                }}
              >
                {meta.name}
              </MenuItem>
            );
          })}
        </MenuList>
      </Popover>
    </>
  );
}
