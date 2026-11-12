/**
 * localStorage that never throws (private windows, disabled storage, quota).
 * Values are stored as JSON under an `openboard.` prefix.
 */
const PREFIX = 'openboard.';

function backend(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readStored<T>(key: string, accept: (value: unknown) => value is T): T | undefined {
  try {
    const raw = backend()?.getItem(PREFIX + key);
    if (raw == null) return undefined;
    const value: unknown = JSON.parse(raw);
    return accept(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    backend()?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage is a convenience; losing a preference is not worth an error.
  }
}

export const isString = (value: unknown): value is string => typeof value === 'string';
export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
