/**
 * Modal dialog on the native <dialog> element, which traps focus, makes the
 * rest of the page inert and closes on Escape.
 */
import { type ReactNode, useEffect, useRef } from 'react';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Visually hide the title (it is still the dialog's accessible name). */
  hideTitle?: boolean;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function Dialog({
  open,
  onClose,
  title,
  hideTitle,
  description,
  children,
  className,
  size = 'sm',
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      const previous = document.activeElement as HTMLElement | null;
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
      return () => {
        if (el.open) {
          if (typeof el.close === 'function') el.close();
          else el.removeAttribute('open');
        }
        previous?.focus?.();
      };
    }
    return undefined;
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${size}${className ? ` ${className}` : ''}`}
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === ref.current) onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="dialog-body">
        <h2 id="dialog-title" className={hideTitle ? 'visually-hidden' : 'dialog-title'}>
          {title}
        </h2>
        {description && <div className="dialog-description">{description}</div>}
        {children}
      </div>
    </dialog>
  );
}
