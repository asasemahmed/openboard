/** Short status messages ("Moved 12 nodes", "Could not connect…"). */
import { Emitter, useStoreValue } from './emitter.js';

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
  action?: { label: string; run: () => void };
}

class ToastStore extends Emitter {
  toasts: readonly Toast[] = [];
  private next = 1;

  readonly get = (): readonly Toast[] => this.toasts;

  show(
    message: string,
    opts: Partial<Omit<Toast, 'id' | 'message'>> & { ms?: number } = {},
  ): number {
    const id = this.next++;
    const toast: Toast = { id, message, tone: opts.tone ?? 'info' };
    if (opts.action) toast.action = opts.action;
    this.toasts = [...this.toasts.slice(-3), toast];
    this.emit();
    setTimeout(() => this.dismiss(id), opts.ms ?? (toast.tone === 'error' ? 7000 : 3500));
    return id;
  }

  dismiss(id: number): void {
    if (!this.toasts.some((t) => t.id === id)) return;
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit();
  }
}

export const toasts = new ToastStore();

export function useToasts(): readonly Toast[] {
  return useStoreValue(toasts, toasts.get);
}
