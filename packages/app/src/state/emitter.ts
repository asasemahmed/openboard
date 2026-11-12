import { useSyncExternalStore } from 'react';

/** Base for the app's external stores, read with `useSyncExternalStore`. */
export class Emitter {
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  protected emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Read a value from an external store. `get` must return the same reference
 * (or an equal primitive) until the store actually changes.
 */
export function useStoreValue<T>(store: Emitter, get: () => T): T {
  return useSyncExternalStore(store.subscribe, get, get);
}

/** A tiny observable value for UI state. */
export class Value<T> extends Emitter {
  private current: T;

  constructor(initial: T) {
    super();
    this.current = initial;
  }

  readonly get = (): T => this.current;

  set(next: T): void {
    if (Object.is(next, this.current)) return;
    this.current = next;
    this.emit();
  }

  update(fn: (value: T) => T): void {
    this.set(fn(this.current));
  }
}

export function useValue<T>(value: Value<T>): T {
  return useSyncExternalStore(value.subscribe, value.get, value.get);
}
