import type { SchemaNodeType } from '@openboard/core';
import { useRef, useState } from 'react';
import { useActions } from '../canvas/actions.js';
import { shortHint } from '../lib/declaredTypes.js';
import { ADDABLE_TYPES, typeMeta } from '../lib/nodeTypes.js';
import { useTypes } from '../state/schema.js';
import { Button } from '../ui/Button.js';
import { MenuItem, MenuList, MenuSeparator } from '../ui/Menu.js';
import { Popover } from '../ui/Popover.js';
import { TypeIcon } from '../ui/TypeIcon.js';

export function TypeDot({ type }: { type: string }) {
  return <span className={`type-dot tone-${typeMeta(type).tone}`} aria-hidden="true" />;
}

/** A declared type's icon in its colour, or a dot when it has no icon. */
export function DeclaredLead({ def }: { def: SchemaNodeType }) {
  const tone = def.color ? `tone-c-${def.color}` : 'tone-custom';
  return def.icon ? (
    <span className={`type-glyph ${tone}`} aria-hidden="true">
      <TypeIcon name={def.icon} size={14} />
    </span>
  ) : (
    <span className={`type-dot ${tone}`} aria-hidden="true" />
  );
}

/** "Add" menu: one entry per type, added in the middle of the view. */
export function AddMenu() {
  const actions = useActions();
  const declared = useTypes().declaredNodes;
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
          {declared.length > 0 && <MenuSeparator />}
          {declared.map((def) => (
            <MenuItem
              key={def.type}
              lead={<DeclaredLead def={def} />}
              {...(def.description ? { hint: shortHint(def.description) } : {})}
              onSelect={() => {
                setOpen(false);
                actions.addNode(def.type, actions.viewCenter());
              }}
            >
              {def.label}
            </MenuItem>
          ))}
        </MenuList>
      </Popover>
    </>
  );
}
