import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { shortcutKeys } from '../lib/shortcuts.js';
import { Icon, type IconName } from './Icon.js';

type Variant = 'default' | 'primary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: IconName;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Accessible name; also shown as the tooltip. */
  label: string;
  shortcut?: string;
  pressed?: boolean;
  size?: 'sm' | 'md';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, shortcut, pressed, size = 'md', className, type = 'button', ...rest },
  ref,
) {
  const hint = shortcut ? `${label} (${shortcutKeys(shortcut).join(' ')})` : label;
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={hint}
      aria-pressed={pressed}
      className={`icon-btn icon-btn-${size}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
});

export function Kbd({ shortcut }: { shortcut: string }) {
  return (
    <span className="kbd-group" aria-hidden="true">
      {shortcutKeys(shortcut).map((key, i) => (
        <kbd key={`${key}-${i}`} className="kbd">
          {key}
        </kbd>
      ))}
    </span>
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="visually-hidden">{children}</span>;
}
