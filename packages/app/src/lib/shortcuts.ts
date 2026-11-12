/**
 * Keyboard shortcuts as strings such as "n", "mod+k", "shift+mod+z", "?".
 * `mod` is Command on Apple platforms and Control elsewhere.
 */

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** Physical key, e.g. "Digit1"; lets "shift+1" match whatever Shift+1 types. */
  code?: string;
  target?: EventTarget | null;
  isComposing?: boolean;
}

interface Spec {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

const cache = new Map<string, Spec>();

function parse(spec: string): Spec {
  let parsed = cache.get(spec);
  if (parsed) return parsed;
  const parts = spec.toLowerCase().split('+');
  // A trailing "+" means the plus key itself ("mod++").
  const key = spec.endsWith('++') ? '+' : (parts[parts.length - 1] ?? '');
  const mods = new Set(parts.slice(0, -1));
  parsed = { key, mod: mods.has('mod'), shift: mods.has('shift'), alt: mods.has('alt') };
  cache.set(spec, parsed);
  return parsed;
}

export const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** True when the key should go to a text field, not to the canvas. */
export function isTypingTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset'].includes(type);
  }
  return el.closest('[contenteditable="true"]') !== null;
}

/**
 * Does `event` press `spec`? Letters compare case-insensitively and require
 * the exact modifiers. Symbols that need Shift to type ("?") ignore Shift.
 */
export function matchesShortcut(event: KeyLike, spec: string, isMac = IS_MAC): boolean {
  if (event.isComposing) return false;
  const s = parse(spec);
  const key = event.key.toLowerCase();
  const wanted = s.key === 'space' ? ' ' : s.key === 'esc' ? 'escape' : s.key;
  const digitCode = /^[0-9]$/.test(wanted) && event.code === `Digit${wanted}`;
  if (key !== wanted && !digitCode) return false;
  const modDown = isMac ? event.metaKey : event.ctrlKey;
  const otherDown = isMac ? event.ctrlKey : event.metaKey;
  if (modDown !== s.mod || otherDown) return false;
  if (event.altKey !== s.alt) return false;
  const isSymbol = wanted.length === 1 && !/[a-z0-9]/.test(wanted);
  if (!isSymbol && event.shiftKey !== s.shift) return false;
  return true;
}

/** Keys a shortcut is drawn with, e.g. ["⌘", "⇧", "Z"] or ["Ctrl", "Shift", "Z"]. */
export function shortcutKeys(spec: string, isMac = IS_MAC): string[] {
  const s = parse(spec);
  const out: string[] = [];
  if (s.mod) out.push(isMac ? '⌘' : 'Ctrl');
  if (s.alt) out.push(isMac ? '⌥' : 'Alt');
  if (s.shift) out.push(isMac ? '⇧' : 'Shift');
  const names: Record<string, string> = {
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    escape: 'Esc',
    esc: 'Esc',
    enter: 'Enter',
    backspace: isMac ? '⌫' : 'Backspace',
    delete: 'Delete',
    space: 'Space',
  };
  out.push(names[s.key] ?? s.key.toUpperCase());
  return out;
}
