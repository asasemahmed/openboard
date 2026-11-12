/**
 * Menu content for a Popover: items move focus with the arrow keys, Home
 * and End, and run on Enter or click.
 */
import type { KeyboardEvent, ReactNode } from 'react';
import { Kbd } from './Button.js';
import { Icon, type IconName } from './Icon.js';

export function MenuList({ children, label }: { children: ReactNode; label?: string }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemradio"]',
      ),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    if (next >= 0) {
      event.preventDefault();
      items[next]?.focus();
    }
  };
  return (
    <div className="menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

export interface MenuItemProps {
  onSelect: () => void;
  icon?: IconName;
  /** Rendered before the label instead of an icon (e.g. a type dot). */
  lead?: ReactNode;
  shortcut?: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  tone?: 'danger';
  children: ReactNode;
}

export function MenuItem({
  onSelect,
  icon,
  lead,
  shortcut,
  hint,
  checked,
  disabled,
  tone,
  children,
}: MenuItemProps) {
  const radio = checked !== undefined;
  return (
    <button
      type="button"
      role={radio ? 'menuitemradio' : 'menuitem'}
      aria-checked={radio ? checked : undefined}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      className={`menu-item${tone ? ` menu-item-${tone}` : ''}`}
      onClick={() => {
        if (!disabled) onSelect();
      }}
    >
      <span className="menu-item-lead">
        {lead ?? (icon ? <Icon name={icon} /> : radio && checked ? <Icon name="check" /> : null)}
      </span>
      <span className="menu-item-label">
        {children}
        {hint && <span className="menu-item-hint">{hint}</span>}
      </span>
      {shortcut && <Kbd shortcut={shortcut} />}
    </button>
  );
}

export function MenuSeparator() {
  return <hr className="menu-sep" />;
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return (
    <div className="menu-heading" role="presentation">
      {children}
    </div>
  );
}
