/**
 * An anchored surface (menus, pickers). Rendered in a portal, positioned
 * under its anchor, closed by Escape or a click outside; focus returns to
 * the anchor on close.
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export interface PopoverProps {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: 'start' | 'end';
  /** Open above the anchor instead of below. */
  side?: 'bottom' | 'top';
  className?: string;
  label?: string;
  role?: 'dialog' | 'menu' | 'listbox';
}

export function Popover({
  anchor,
  open,
  onClose,
  children,
  align = 'start',
  side = 'bottom',
  className,
  label,
  role = 'dialog',
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const el = ref.current;
      if (!a || !el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let left = align === 'start' ? a.left : a.right - w;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      let top = side === 'bottom' ? a.bottom + 6 : a.top - h - 6;
      if (side === 'bottom' && top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
      if (side === 'top' && top < 8) top = a.bottom + 6;
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, anchor, align, side]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, [open, onClose, anchor]);

  // Move focus in on open; hand it back to the anchor on close.
  useEffect(() => {
    if (!open) return;
    const anchorEl = anchor.current;
    const frame = requestAnimationFrame(() => {
      const first = ref.current?.querySelector<HTMLElement>(
        '[data-autofocus], [role="menuitem"], [role="menuitemradio"], input, button, textarea, select',
      );
      first?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (anchorEl && ref.current?.contains(document.activeElement)) anchorEl.focus();
    };
  }, [open, anchor]);

  if (!open) return null;

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      onClose();
      anchor.current?.focus();
    }
  };

  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      className={`popover${className ? ` ${className}` : ''}`}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}
