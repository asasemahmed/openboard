/** Structural equality for JSON values; key order does not matter and `undefined` counts as absent. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => jsonEqual(value, b[i]));
  }
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(b)) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keysX = Object.keys(x).filter((key) => x[key] !== undefined);
  const keysY = Object.keys(y).filter((key) => y[key] !== undefined);
  if (keysX.length !== keysY.length) return false;
  return keysX.every((key) => jsonEqual(x[key], y[key]));
}
